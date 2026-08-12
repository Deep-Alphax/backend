import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../prisma/prisma.module';
import { CommonModule } from '../../common/common.module';
import { MARKET_DATA_PROVIDER } from './providers/market-data-provider.interface';
import { MoralisProvider } from './providers/moralis.provider';
import { WalletSyncService } from './ingestion/wallet-sync.service';
import { CandleService } from './candle.service';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';

/**
 * Analytics de carteiras:
 *  - provider de dados (atrás do token MARKET_DATA_PROVIDER, trocável);
 *  - ingestão de swaps (WalletSyncService + cron);
 *  - motor de PnL FIFO + endpoints de leitura (AnalyticsService/Controller).
 */
@Module({
  imports: [PrismaModule, HttpModule, ConfigModule, CommonModule],
  controllers: [AnalyticsController],
  providers: [
    { provide: MARKET_DATA_PROVIDER, useClass: MoralisProvider },
    WalletSyncService,
    CandleService,
    AnalyticsService,
  ],
  exports: [
    MARKET_DATA_PROVIDER,
    WalletSyncService,
    AnalyticsService,
    CandleService,
  ],
})
export class AnalyticsModule {}
