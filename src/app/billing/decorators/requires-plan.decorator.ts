import { SetMetadata } from '@nestjs/common';
import { Plan } from '@prisma/client';

export const REQUIRES_PLAN = 'requiresPlan';

/**
 * Marca uma rota (ou um controller inteiro) como exigindo um plano mínimo.
 * Lido pelo `PlanGuard`. Use junto do `JwtAuthGuard` — sem usuário autenticado
 * o guard rejeita, porque plano é sempre de alguém.
 *
 * @example
 * ```ts
 * @UseGuards(JwtAuthGuard, PlanGuard)
 * @RequiresPlan(Plan.PRO)
 * @Get('alertas')
 * listAlerts() {}
 * ```
 */
export const RequiresPlan = (plan: Plan) => SetMetadata(REQUIRES_PLAN, plan);
