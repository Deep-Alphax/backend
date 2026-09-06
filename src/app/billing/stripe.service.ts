import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

/** Versão da API fixada. Nunca deixe implícita: o Stripe evolui o schema e uma
 *  troca silenciosa muda o formato do evento que o webhook desserializa. */
const API_VERSION = '2026-08-26.dahlia';

/**
 * Dono do cliente Stripe. Instancia UM `Stripe` e o compartilha — nada de
 * `stripe.api_key = …` (padrão global, depreciado em todos os SDKs atuais).
 *
 * Sem chave configurada o serviço NÃO derruba a aplicação: `enabled` fica false
 * e quem depende de billing responde erro claro. O backend inteiro não pode cair
 * porque a integração de pagamento ainda não foi ligada num ambiente.
 */
@Injectable()
export class StripeService implements OnModuleInit {
  private readonly logger = new Logger(StripeService.name);
  private client?: Stripe;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    const key = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (!key) {
      this.logger.warn(
        'STRIPE_SECRET_KEY ausente — billing desligado neste ambiente.',
      );
      return;
    }
    this.client = new Stripe(key, { apiVersion: API_VERSION });
    // `sk_` funciona, mas o recomendado é uma chave RESTRITA (`rk_`) com escopo
    // só de Checkout/Billing/Webhook — limita o estrago de um vazamento.
    if (key.startsWith('sk_')) {
      this.logger.warn(
        'Usando chave secreta (sk_). Prefira uma chave restrita (rk_) com escopo mínimo.',
      );
    }
  }

  /** `false` quando não há chave — o chamador decide como degradar. */
  get enabled(): boolean {
    return Boolean(this.client);
  }

  /** Cliente pronto. Lança se billing não estiver configurado neste ambiente. */
  get stripe(): Stripe {
    if (!this.client) {
      throw new Error('Stripe não configurado (STRIPE_SECRET_KEY ausente).');
    }
    return this.client;
  }

  /** Segredo de assinatura do endpoint de webhook (difere entre dev e prod). */
  get webhookSecret(): string | undefined {
    return this.configService.get<string>('STRIPE_WEBHOOK_SECRET');
  }

  /** Price recorrente do plano PRO. */
  get proPriceId(): string | undefined {
    return this.configService.get<string>('STRIPE_PRICE_PRO_MONTHLY');
  }
}
