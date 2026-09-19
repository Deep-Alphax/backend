import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { EntitlementsModule } from './entitlements.module';
import { StripeService } from './stripe.service';
import { AffiliatesModule } from '../affiliates/affiliates.module';

/**
 * Billing: assinatura, webhook e o gate de plano.
 *
 * A divisão importa: `EntitlementsService` + `PlanGuard` não conhecem provedor
 * nenhum — decidem acesso a partir da tabela local. Só `StripeService` e
 * `BillingService` falam com o Stripe. Trocar (ou somar) um provedor mexe
 * naqueles dois, e o gate de acesso continua igual.
 */
@Module({
  imports: [PrismaModule, AffiliatesModule, EntitlementsModule],
  controllers: [BillingController],
  providers: [StripeService, BillingService],
  exports: [EntitlementsModule],
})
export class BillingModule {}
