import { Plan, SubscriptionStatus } from '@prisma/client';

/**
 * Decide o plano efetivo a partir da assinatura. Função PURA e sem Prisma de
 * propósito: é a regra que libera ou barra recurso pago, então precisa ser
 * testável sem banco e sem mock.
 *
 * Duas travas explícitas:
 *  - só ACTIVE e TRIALING concedem. PAST_DUE **não** concede: se a cobrança
 *    falhou, o acesso para. (Se um dia quiserem período de tolerância, ele entra
 *    aqui de forma visível, não escondido num status do provedor.)
 *  - `currentPeriodEnd` no passado derruba o acesso mesmo com status ACTIVE.
 *    Isso é o que evita PRO vitalício quando um webhook de cancelamento se
 *    perde — o banco nunca fica "esperando" um evento que pode não chegar.
 */

/** Só o que a decisão precisa — não é a linha inteira do Prisma. */
export interface EntitlementInput {
  plan: Plan;
  status: SubscriptionStatus;
  currentPeriodEnd: Date | null;
}

const GRANTING: ReadonlySet<SubscriptionStatus> = new Set([
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.TRIALING,
]);

/** `true` quando a assinatura concede o plano dela agora. */
export function isEntitled(
  subscription: EntitlementInput | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!subscription) return false;
  if (!GRANTING.has(subscription.status)) return false;
  // Sem data de fim ainda (assinatura recém-criada que já veio ACTIVE do
  // provedor) não bloqueia — quem bloqueia é uma data JÁ vencida.
  if (subscription.currentPeriodEnd && subscription.currentPeriodEnd <= now) {
    return false;
  }
  return true;
}

/** Plano efetivo. FREE é o piso: nunca depende de haver linha no banco. */
export function effectivePlan(
  subscription: EntitlementInput | null | undefined,
  now: Date = new Date(),
): Plan {
  return isEntitled(subscription, now) ? subscription!.plan : Plan.FREE;
}

/** Ordem dos planos, para "exige PRO" aceitar qualquer plano igual ou acima. */
const RANK: Record<Plan, number> = {
  [Plan.FREE]: 0,
  [Plan.PRO]: 1,
};

/** `true` quando `plan` satisfaz a exigência de `required`. */
export function satisfies(plan: Plan, required: Plan): boolean {
  return RANK[plan] >= RANK[required];
}
