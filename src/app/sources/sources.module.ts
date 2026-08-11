import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { SourcesController } from './sources.controller';
import { SourcesService } from './sources.service';
import { SourceSyncListener } from './source-sync.listener';

/**
 * Fontes de alpha: CRUD, atribuição lead-lag e agregação por fonte.
 * Importa AnalyticsModule só para reusar o CandleService (capture best-effort).
 * A reatribuição pós-sync é acionada por evento (`wallet.synced`), sem acoplar
 * a ingestão a este módulo.
 */
@Module({
  imports: [PrismaModule, AnalyticsModule],
  controllers: [SourcesController],
  providers: [SourcesService, SourceSyncListener],
  exports: [SourcesService],
})
export class SourcesModule {}
