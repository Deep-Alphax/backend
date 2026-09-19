import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';
import { EntitlementsModule } from '../billing/entitlements.module';

// AnalyticsModule exporta o WalletSyncService (usado para disparar a ingestão
// imediata ao cadastrar uma carteira).
@Module({
  imports: [PrismaModule, AnalyticsModule, EntitlementsModule],
  controllers: [WalletsController],
  providers: [WalletsService],
  exports: [WalletsService],
})
export class WalletsModule {}
