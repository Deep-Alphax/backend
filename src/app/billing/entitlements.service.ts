import { Injectable } from '@nestjs/common';
import { Plan, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { effectivePlan, satisfies } from './entitlement';
import { limitsFor, type PlanLimits } from './plan-limits';

/**
 * Fonte única de "este usuário tem PRO?". Todo gate de recurso pago passa por
 * aqui — nunca leia `subscription.status` solto num serviço, senão a regra de
 * expiração (ver `entitlement.ts`) fica duplicada e diverge.
 *
 * O plano NÃO é campo do usuário: é derivado da assinatura a cada consulta. Uma
 * leitura a mais por request em troca de nunca haver `user.plan` desatualizado
 * em relação à cobrança real.
 */
@Injectable()
export class EntitlementsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Plano efetivo agora. FREE quando não há assinatura viva.
   *
   * ADMIN conta como PRO (decisão de produto): quem opera o painel precisa ver
   * o produto inteiro — feed de todos os grupos, carteiras dos KOLs — sem ter
   * que assinar. Papel e assinatura saem na MESMA query (um round-trip só).
   */
  async planFor(userId: string): Promise<Plan> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        role: true,
        subscription: {
          select: { plan: true, status: true, currentPeriodEnd: true },
        },
      },
    });
    if (!user) return Plan.FREE;
    if (user.role === Role.ADMIN) return Plan.PRO;
    return effectivePlan(user.subscription);
  }

  /**
   * Plano de VÁRIOS usuários numa query só — para caminhos em lote (disparo de
   * alertas de uma captura), onde `planFor` em loop seria N+1. Mesma regra:
   * ADMIN = PRO; senão, a assinatura decide. Id desconhecido não entra no mapa.
   */
  async plansFor(userIds: string[]): Promise<Map<string, Plan>> {
    if (userIds.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: {
        id: true,
        role: true,
        subscription: {
          select: { plan: true, status: true, currentPeriodEnd: true },
        },
      },
    });
    return new Map(
      users.map((u) => [
        u.id,
        u.role === Role.ADMIN ? Plan.PRO : effectivePlan(u.subscription),
      ]),
    );
  }

  /** Limites do plano efetivo (ver `plan-limits.ts`). */
  async limitsFor(userId: string): Promise<PlanLimits> {
    return limitsFor(await this.planFor(userId));
  }

  /** Atalho para os gates que só distinguem FREE de PRO. */
  async isPro(userId: string): Promise<boolean> {
    return this.hasPlan(userId, Plan.PRO);
  }

  /** `true` se o usuário atende (ou supera) o plano exigido. */
  async hasPlan(userId: string, required: Plan): Promise<boolean> {
    return satisfies(await this.planFor(userId), required);
  }
}
