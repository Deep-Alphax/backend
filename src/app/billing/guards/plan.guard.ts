import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Plan } from '@prisma/client';
import { EntitlementsService } from '../entitlements.service';
import { REQUIRES_PLAN } from '../decorators/requires-plan.decorator';

/**
 * Barra rotas marcadas com `@RequiresPlan(...)`. Roda DEPOIS do `JwtAuthGuard`
 * (que popula `request.user`).
 *
 * Fail-secure: sem a metadata o guard libera (a rota não pediu plano), mas sem
 * usuário autenticado ele rejeita — nunca assume FREE anônimo para "deixar
 * passar". A resposta é 403 com um código estável (`PLAN_REQUIRED`) para o
 * front distinguir "não pode" de "não pagou" e abrir o upsell de /plans.
 */
@Injectable()
export class PlanGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<Plan | undefined>(
      REQUIRES_PLAN,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;

    const request = context.switchToHttp().getRequest();
    const userId = request.user?.id;
    if (!userId) throw new UnauthorizedException('Usuário não autenticado');

    if (await this.entitlements.hasPlan(userId, required)) return true;

    throw new ForbiddenException({
      code: 'PLAN_REQUIRED',
      requiredPlan: required,
      message: `Este recurso exige o plano ${required}.`,
    });
  }
}
