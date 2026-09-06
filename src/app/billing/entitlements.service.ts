import { Injectable } from '@nestjs/common';
import { Plan } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { effectivePlan, satisfies } from './entitlement';

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

  /** Plano efetivo agora. FREE quando não há assinatura viva. */
  async planFor(userId: string): Promise<Plan> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { userId },
      select: { plan: true, status: true, currentPeriodEnd: true },
    });
    return effectivePlan(subscription);
  }

  /** `true` se o usuário atende (ou supera) o plano exigido. */
  async hasPlan(userId: string, required: Plan): Promise<boolean> {
    return satisfies(await this.planFor(userId), required);
  }
}
