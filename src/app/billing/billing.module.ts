import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { EntitlementsService } from './entitlements.service';
import { StripeService } from './stripe.service';
import { PlanGuard } from './guards/plan.guard';

/**
 * Billing: assinatura, webhook e o gate de plano.
 *
 * A divisão importa: `EntitlementsService` + `PlanGuard` não conhecem provedor
 * nenhum — decidem acesso a partir da tabela local. Só `StripeService` e
 * `BillingService` falam com o Stripe. Trocar (ou somar) um provedor mexe
 * naqueles dois, e o gate de acesso continua igual.
 */
@Module({
  imports: [PrismaModule],
  controllers: [BillingController],
  providers: [StripeService, BillingService, EntitlementsService, PlanGuard],
  exports: [EntitlementsService, PlanGuard],
})
export class BillingModule {}
