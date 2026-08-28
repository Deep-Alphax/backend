import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { AnalyticsModule } from '../analytics/analytics.module';
import { WalletReaderController } from './wallet-reader.controller';
import { WalletReaderService } from './wallet-reader.service';
import { KolIndexController } from './kol-index.controller';
import { KolAdminController } from './kol-admin.controller';
import { KolIndexService } from './kol-index.service';

/**
 * Wallet Reader (KOL Index): o índice em duas camadas (preset global + override
 * por conta) e a varredura de sidewallets/copytraders.
 *
 * Importa `AnalyticsModule` pelo `MARKET_DATA_PROVIDER` — a varredura reusa o
 * mesmo provider de swaps da ingestão em vez de abrir uma segunda fonte.
 */
@Module({
  imports: [HttpModule, ConfigModule, AnalyticsModule],
  controllers: [WalletReaderController, KolIndexController, KolAdminController],
  providers: [WalletReaderService, KolIndexService],
})
export class WalletReaderModule {}
