import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { SourcesService } from './sources.service';
import {
  WALLET_SYNCED_EVENT,
  WalletSyncedEvent,
} from '../analytics/ingestion/wallet-sync.service';

/**
 * Recomputa a atribuição por fonte sempre que uma carteira do usuário sincroniza
 * com trades novos — tanto carteiras OWN (novas compras dele) quanto SOURCE
 * (novas compras da fonte) mudam o casamento lead-lag. Desacoplado via eventos:
 * a ingestão (AnalyticsModule) não conhece o SourcesModule.
 */
@Injectable()
export class SourceSyncListener {
  private readonly logger = new Logger(SourceSyncListener.name);

  constructor(private readonly sources: SourcesService) {}

  @OnEvent(WALLET_SYNCED_EVENT, { async: true })
  async onWalletSynced(evt: WalletSyncedEvent): Promise<void> {
    if (evt.inserted <= 0) return;
    try {
      await this.sources.reattributeUser(evt.userId);
    } catch (err) {
      this.logger.warn(
        `Reatribuição pós-sync falhou (user ${evt.userId}): ${(err as Error)?.message}`,
      );
    }
  }
}
