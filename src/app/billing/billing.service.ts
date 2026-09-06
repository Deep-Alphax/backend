import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, SubscriptionStatus } from '@prisma/client';
import type Stripe from 'stripe';
import { PrismaService } from '../../prisma/prisma.service';
import { StripeService } from './stripe.service';
import { epochToDate, mapSubscriptionStatus } from './stripe-mapping';

/** Eventos que mexem no estado da assinatura. O resto é ignorado (com 200). */
const HANDLED = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
]);

/** Chave de metadata que carrega o nosso userId até o webhook. */
const USER_ID_KEY = 'deepAlphaUserId';

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Cria a sessão de Checkout de assinatura e devolve a URL.
   *
   * NÃO passa `payment_method_types` de propósito: omitir liga os métodos
   * dinâmicos, então Pix aparece sozinho no dia em que a capacidade for ativada
   * na conta — sem tocar neste código. Fixar `['card']` travaria isso.
   */
  async createCheckoutSession(userId: string): Promise<{ url: string }> {
    const priceId = this.stripeService.proPriceId;
    if (!priceId) {
      throw new BadRequestException(
        'STRIPE_PRICE_PRO_MONTHLY não configurado.',
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, subscription: true },
    });
    if (!user) throw new BadRequestException('Usuário não encontrado.');

    const appUrl =
      this.configService.get<string>('FRONTEND_URL') ?? 'http://localhost:3000';

    const session = await this.stripeService.stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      // Reaproveita o customer quando já existe — evita duplicar cliente no
      // Stripe a cada tentativa de assinatura do mesmo usuário.
      customer: user.subscription?.providerCustomerId ?? undefined,
      customer_email: user.subscription?.providerCustomerId
        ? undefined
        : user.email,
      // O webhook chega sem sessão HTTP: é por esta metadata que ele descobre
      // de quem é a assinatura. Vai nos dois lugares porque os eventos de
      // `customer.subscription.*` carregam a metadata DA ASSINATURA, não a da
      // sessão de checkout.
      metadata: { [USER_ID_KEY]: user.id },
      subscription_data: { metadata: { [USER_ID_KEY]: user.id } },
      success_url: `${appUrl}/plans?checkout=success`,
      cancel_url: `${appUrl}/plans?checkout=cancelled`,
      integration_identifier: 'deepalpha-pro-qkzrmwvt',
    });

    if (!session.url) {
      throw new BadRequestException('Stripe não devolveu URL de checkout.');
    }
    return { url: session.url };
  }

  /**
   * Verifica a assinatura do webhook e devolve o evento. Usa o RAW BODY — o
   * corpo já desserializado NÃO serve, a assinatura é sobre os bytes originais.
   *
   * ATENÇÃO (acoplamento invisível): `req.rawBody` existe porque o `main.ts`
   * registra `express.json({ verify })`. Se aquele bloco mudar, a verificação
   * aqui quebra em silêncio — o Stripe passa a receber 400 e os eventos se
   * acumulam sem ninguém perceber.
   */
  constructEvent(rawBody: Buffer | undefined, signature: string): Stripe.Event {
    const secret = this.stripeService.webhookSecret;
    if (!secret) {
      throw new BadRequestException('STRIPE_WEBHOOK_SECRET não configurado.');
    }
    if (!rawBody) {
      throw new BadRequestException('Corpo bruto ausente na requisição.');
    }
    try {
      return this.stripeService.stripe.webhooks.constructEvent(
        rawBody,
        signature,
        secret,
      );
    } catch (err) {
      // Assinatura inválida = requisição não veio do Stripe. 400 e ponto — sem
      // detalhar o motivo, para não virar oráculo de forja de assinatura.
      this.logger.warn(
        `Assinatura de webhook inválida: ${(err as Error).message}`,
      );
      throw new BadRequestException('Assinatura inválida.');
    }
  }

  /**
   * Processa o evento UMA vez. A trava de idempotência é um INSERT em
   * `BillingEvent` com o `event.id` como PK: se o Stripe reentregar (e ele
   * reentrega), o INSERT falha com P2002 e saímos sem efeito colateral. Sem
   * isso, um `invoice.paid` repetido estenderia o período pago duas vezes.
   */
  async handleEvent(event: Stripe.Event): Promise<{ handled: boolean }> {
    if (!HANDLED.has(event.type)) return { handled: false };

    try {
      await this.prisma.billingEvent.create({
        data: { id: event.id, type: event.type },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        this.logger.log(`Evento ${event.id} já processado — ignorando.`);
        return { handled: false };
      }
      throw err;
    }

    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        await this.onCheckoutSession(event.data.object);
        break;
      case 'checkout.session.async_payment_failed':
        // Pix não pago dentro da validade. Nada a revogar: o acesso só é dado
        // quando o pagamento confirma.
        this.logger.log(`Checkout assíncrono falhou: ${event.id}`);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await this.onSubscription(event.data.object);
        break;
      case 'invoice.paid':
      case 'invoice.payment_failed':
        await this.onInvoice(event.data.object);
        break;
    }

    return { handled: true };
  }

  /**
   * Fim do checkout. `payment_status` é o que decide: com Pix, o `completed`
   * chega ANTES do pagamento (o cliente ainda vai pagar o QR). Liberar PRO aqui
   * sem checar daria acesso de graça a quem nunca pagou.
   */
  private async onCheckoutSession(
    session: Stripe.Checkout.Session,
  ): Promise<void> {
    if (session.payment_status !== 'paid') {
      this.logger.log(
        `Checkout ${session.id} ainda não pago (${session.payment_status}) — aguardando confirmação.`,
      );
      return;
    }
    const userId = session.metadata?.[USER_ID_KEY];
    const subscriptionId = asId(session.subscription);
    if (!userId || !subscriptionId) return;

    // Busca a assinatura para gravar status e período reais, em vez de assumir.
    const subscription =
      await this.stripeService.stripe.subscriptions.retrieve(subscriptionId);
    await this.upsert(userId, subscription, asId(session.customer));
  }

  /** Ciclo de vida da assinatura: criada, atualizada, cancelada. */
  private async onSubscription(
    subscription: Stripe.Subscription,
  ): Promise<void> {
    const userId = subscription.metadata?.[USER_ID_KEY];
    if (userId) {
      await this.upsert(userId, subscription, asId(subscription.customer));
      return;
    }
    // Sem metadata (assinatura criada fora do nosso fluxo): tenta casar pelo id
    // já gravado. Se não achar, não há como saber de quem é — loga e sai.
    const existing = await this.prisma.subscription.findUnique({
      where: { providerSubscriptionId: subscription.id },
      select: { userId: true },
    });
    if (!existing) {
      this.logger.warn(
        `Assinatura ${subscription.id} sem ${USER_ID_KEY} e sem correspondência local.`,
      );
      return;
    }
    await this.upsert(
      existing.userId,
      subscription,
      asId(subscription.customer),
    );
  }

  /** Renovação paga ou falha de cobrança — reespelha a assinatura da fatura. */
  private async onInvoice(invoice: Stripe.Invoice): Promise<void> {
    const subscriptionId = asId(
      (invoice as unknown as { subscription?: unknown }).subscription,
    );
    if (!subscriptionId) return;
    const subscription =
      await this.stripeService.stripe.subscriptions.retrieve(subscriptionId);
    const userId =
      subscription.metadata?.[USER_ID_KEY] ??
      (
        await this.prisma.subscription.findUnique({
          where: { providerSubscriptionId: subscription.id },
          select: { userId: true },
        })
      )?.userId;
    if (!userId) return;
    await this.upsert(userId, subscription, asId(subscription.customer));
  }

  /**
   * Espelha o estado do Stripe na nossa tabela. O Stripe é a fonte da verdade
   * da cobrança; aqui é só a projeção que o gate de entitlement consulta.
   */
  private async upsert(
    userId: string,
    subscription: Stripe.Subscription,
    customerId: string | null,
  ): Promise<void> {
    const status = mapSubscriptionStatus(subscription.status);
    const periodEnd = epochToDate(
      (subscription as unknown as { current_period_end?: unknown })
        .current_period_end,
    );

    const data = {
      status,
      providerSubscriptionId: subscription.id,
      providerCustomerId: customerId,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
      canceledAt: epochToDate(subscription.canceled_at),
    };

    await this.prisma.subscription.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });

    this.logger.log(
      `Assinatura de ${userId} → ${status}` +
        (periodEnd ? ` até ${periodEnd.toISOString()}` : ''),
    );
  }
}

/** O Stripe devolve `string | objeto | null` conforme o expand. Normaliza. */
function asId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id;
    return typeof id === 'string' ? id : null;
  }
  return null;
}

export { SubscriptionStatus };
