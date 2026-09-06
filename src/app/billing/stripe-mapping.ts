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
