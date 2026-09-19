/**
 * Emitido quando a assinatura de alguém é regravada (webhook do Stripe). O
 * gateway de tempo real escuta para trocar as conexões ABERTAS de sala — sem
 * isso, quem assina continuaria recebendo o feed do FREE até recarregar, e quem
 * cancela continuaria no do PRO.
 */
export const PLAN_CHANGED_EVENT = 'billing.plan-changed';

export interface PlanChangedEvent {
  userId: string;
}
