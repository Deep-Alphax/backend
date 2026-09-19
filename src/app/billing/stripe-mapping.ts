import { SubscriptionStatus } from '@prisma/client';

/**
 * Traduz o status do Stripe para o nosso. Função PURA: é o ponto onde um engano
 * vira acesso pago liberado de graça, então precisa ser testável sem rede.
 *
 * A regra de ouro é FAIL-SECURE: qualquer status novo ou desconhecido cai em
 * INCOMPLETE, que NÃO concede. O Stripe pode introduzir status a qualquer
 * momento; o default nunca pode ser "libera".
 */
export function mapSubscriptionStatus(status: string): SubscriptionStatus {
  switch (status) {
    case 'active':
      return SubscriptionStatus.ACTIVE;
    case 'trialing':
      return SubscriptionStatus.TRIALING;
    case 'past_due':
      return SubscriptionStatus.PAST_DUE;
    // `unpaid`: as retentativas de cobrança acabaram. `paused`: trial terminou
    // sem forma de pagamento. Nenhum dos dois é cancelamento definitivo, mas
    // nenhum concede acesso — e o nosso enum não precisa dessa distinção.
    case 'unpaid':
    case 'paused':
      return SubscriptionStatus.PAST_DUE;
    case 'canceled':
    case 'incomplete_expired':
      return SubscriptionStatus.CANCELED;
    case 'incomplete':
      return SubscriptionStatus.INCOMPLETE;
    default:
      return SubscriptionStatus.INCOMPLETE;
  }
}

/**
 * Converte epoch em segundos (formato do Stripe) para `Date`. Devolve `null`
 * para ausente/inválido — nunca uma data inventada, que viraria acesso
 * concedido ou revogado por engano.
 */
export function epochToDate(seconds: unknown): Date | null {
  if (
    typeof seconds !== 'number' ||
    !Number.isFinite(seconds) ||
    seconds <= 0
  ) {
    return null;
  }
  return new Date(seconds * 1000);
}

/**
 * Fim do período pago da assinatura.
 *
 * Desde a API `2025-03-31.basil` o `current_period_end` saiu da assinatura e foi
 * para CADA item (`items.data[].current_period_end`). Lendo só o topo, a data
 * vinha sempre `null` — e a trava de expiração do `entitlement.ts` nunca
 * disparava (PRO vitalício se o webhook de cancelamento se perdesse). O topo
 * fica como fallback para payloads antigos. Com vários itens vale o MENOR fim:
 * é quando o primeiro pedaço da cobrança deixa de estar pago.
 */
export function subscriptionPeriodEnd(subscription: unknown): Date | null {
  const sub = subscription as {
    current_period_end?: unknown;
    items?: { data?: Array<{ current_period_end?: unknown }> };
  } | null;
  const ends = (sub?.items?.data ?? [])
    .map((item) => epochToDate(item?.current_period_end))
    .filter((d): d is Date => d !== null);
  if (ends.length > 0) {
    return new Date(Math.min(...ends.map((d) => d.getTime())));
  }
  return epochToDate(sub?.current_period_end);
}

/**
 * Id da assinatura de uma fatura.
 *
 * Mesma migração de API: `invoice.subscription` virou
 * `invoice.parent.subscription_details.subscription`. Sem isso o `invoice.paid`
 * era ignorado em silêncio — inclusive a apuração de comissão de afiliado.
 */
export function invoiceSubscriptionId(invoice: unknown): string | null {
  const inv = invoice as {
    subscription?: unknown;
    parent?: {
      subscription_details?: { subscription?: unknown } | null;
    } | null;
  } | null;
  return (
    asStripeId(inv?.parent?.subscription_details?.subscription) ??
    asStripeId(inv?.subscription)
  );
}

/** O Stripe devolve `string | objeto | null` conforme o expand. Normaliza. */
export function asStripeId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id;
    return typeof id === 'string' ? id : null;
  }
  return null;
}
