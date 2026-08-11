import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';

// AnalyticsModule exporta o WalletSyncService (usado para disparar a ingestão
// imediata ao cadastrar uma carteira).
@Module({
  imports: [PrismaModule, AnalyticsModule],
  controllers: [WalletsController],
  providers: [WalletsService],
  exports: [WalletsService],
})
export class WalletsModule {}
