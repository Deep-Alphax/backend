import { ForbiddenException } from '@nestjs/common';
import { Plan } from '@prisma/client';

/**
 * Limites de cada plano — a ÚNICA tabela. Os serviços leem daqui em vez de
 * espalhar números mágicos; o texto de /plans no front deve bater com isto.
 *
 *  - `trackedWallets`: linhas no catálogo de carteiras (inclui as de sources).
 *    FREE = a própria carteira.
 *  - `alertRules`: regras de alerta ativas ou não (a regra é o que conta, não
 *    o disparo). `null` = sem limite.
 *  - `allGroups`: FREE só recebe capturas dos grupos que o admin marcou como
 *    gratuitos (`DiscordMonitor.freeTier`).
 *  - `kolWallets`: FREE vê o índice de KOLs, mas sem as carteiras (nem scan).
 */
export interface PlanLimits {
  trackedWallets: number;
  alertRules: number | null;
  allGroups: boolean;
  kolWallets: boolean;
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  [Plan.FREE]: {
    trackedWallets: 1,
    alertRules: 1,
    allGroups: false,
    kolWallets: false,
  },
  [Plan.PRO]: {
    trackedWallets: 20,
    alertRules: null,
    allGroups: true,
    kolWallets: true,
  },
};

export function limitsFor(plan: Plan): PlanLimits {
  return PLAN_LIMITS[plan];
}

/**
 * 403 de teto atingido. Código estável (`PLAN_LIMIT`) para o front abrir o
 * upsell em vez de só mostrar um toast — irmão do `PLAN_REQUIRED` do guard.
 */
export function planLimitError(
  message: string,
  limit: number,
): ForbiddenException {
  return new ForbiddenException({
    code: 'PLAN_LIMIT',
    limit,
    message,
  });
}
