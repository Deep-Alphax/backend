import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { EntitlementsService } from './entitlements.service';
import { PlanGuard } from './guards/plan.guard';

/**
 * Gate de plano, SEPARADO do billing de propósito: feed, carteiras, KOLs,
 * socket e alertas precisam perguntar "é PRO?", e nenhum deles deve arrastar o
 * cliente do Stripe (nem o `AffiliatesModule`) só para isso. Depende apenas do
 * Prisma.
 */
@Module({
  imports: [PrismaModule],
  providers: [EntitlementsService, PlanGuard],
  exports: [EntitlementsService, PlanGuard],
})
export class EntitlementsModule {}
