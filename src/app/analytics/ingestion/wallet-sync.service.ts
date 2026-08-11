import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, SyncStatus, Wallet, WalletKind } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  MARKET_DATA_PROVIDER,
  MarketDataProvider,
  ProviderSwap,
} from '../providers/market-data-provider.interface';

/** Nome do evento emitido quando uma carteira sincroniza com trades novos. */
export const WALLET_SYNCED_EVENT = 'wallet.synced';

/** Payload de `wallet.synced`. Consumido pelo SourcesModule p/ reatribuição. */
export interface WalletSyncedEvent {
  userId: string;
  walletId: string;
  kind: WalletKind;
  inserted: number;
}

/**
 * Ingestão do histórico de swaps de carteiras. Estratégia:
 *   - incremental: pagina a partir de `lastSyncedAt` (idempotente por natureza —
 *     `Trade` tem unique (walletId, txHash, baseMint, side) e usamos
 *     `createMany({ skipDuplicates })`, então re-processar a fronteira não duplica);
 *   - bounded: teto de páginas por execução para respeitar rate limit do provider;
 *   - a cada tick do cron, drena um lote de carteiras PENDING sequencialmente.
 * Ao inserir trades novos, invalida os snapshots de métrica afetados.
 */
@Injectable()
export class WalletSyncService {
  private readonly logger = new Logger(WalletSyncService.name);

  /** Teto de páginas por execução (bound de custo/rate limit). */
  private static readonly MAX_PAGES_PER_RUN = 20;
  /** Carteiras processadas por tick do cron. */
  private static readonly BATCH_PER_TICK = 5;
  /** Tamanho de página pedido ao provider. */
  private static readonly PAGE_SIZE = 100;

  /** Evita sobreposição de execuções do cron (tick lento não empilha). */
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MARKET_DATA_PROVIDER) private readonly provider: MarketDataProvider,
    private readonly events: EventEmitter2,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async drainPending(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const pending = await this.prisma.getReadClient().wallet.findMany({
        where: { syncStatus: SyncStatus.PENDING, isActive: true },
        orderBy: { updatedAt: 'asc' },
        take: WalletSyncService.BATCH_PER_TICK,
      });
      for (const wallet of pending) {
        await this.syncWallet(wallet).catch((err) =>
          this.logger.error(
            `Sync falhou p/ wallet ${wallet.id}: ${err?.message}`,
          ),
        );
      }
    } finally {
      this.running = false;
    }
  }

  /** Sincroniza uma carteira: pagina swaps, persiste trades e atualiza o estado. */
  async syncWallet(wallet: Wallet): Promise<void> {
    const write = this.prisma.getWriteClient();
    await write.wallet.update({
      where: { id: wallet.id },
      data: { syncStatus: SyncStatus.SYNCING, syncError: null },
    });

    try {
      // Dois modos:
      //  - BACKFILL (histórico completo): quando há cursor pendente OU nunca houve
      //    sync completa (lastSyncedAt=null). Pagina TODO o histórico, sem filtro de
      //    data, em lotes de MAX_PAGES_PER_RUN por tick (o cron continua enquanto
      //    sobrar cursor). lastSyncedAt só é gravado ao TERMINAR o backfill.
      //  - INCREMENTAL: após backfill completo (cursor=null, lastSyncedAt setado),
      //    busca só o que é novo desde lastSyncedAt.
      const resumingBackfill = wallet.syncCursor != null;
      const sinceBlockTime =
        !resumingBackfill && wallet.lastSyncedAt ? wallet.lastSyncedAt : null;

      let cursor: string | null = wallet.syncCursor ?? null;
      let pages = 0;
      let inserted = 0;
      let minBlockTime: Date | null = null;

      do {
        const { swaps, nextCursor } = await this.provider.fetchSwaps({
          chain: wallet.chain,
          address: wallet.address,
          cursor,
          sinceBlockTime,
          limit: WalletSyncService.PAGE_SIZE,
        });

        if (swaps.length > 0) {
          inserted += await this.persistSwaps(
            wallet.id,
            wallet.chainType,
            swaps,
          );
          for (const s of swaps) {
            if (!minBlockTime || s.blockTime < minBlockTime)
              minBlockTime = s.blockTime;
          }
        }

        cursor = nextCursor;
        pages += 1;
      } while (cursor && pages < WalletSyncService.MAX_PAGES_PER_RUN);

      // firstTxAt = menor blockTime já visto (mantém o mais antigo entre runs).
      const firstTxAt =
        minBlockTime && (!wallet.firstTxAt || minBlockTime < wallet.firstTxAt)
          ? minBlockTime
          : wallet.firstTxAt;

      const morePages = !!cursor;
      await write.wallet.update({
        where: { id: wallet.id },
        data: {
          // Ainda há histórico → PENDING para o cron continuar o backfill no próximo tick.
          syncStatus: morePages ? SyncStatus.PENDING : SyncStatus.SYNCED,
          syncCursor: cursor,
          // lastSyncedAt só quando terminou (marca o ponto de corte do modo incremental).
          ...(morePages ? {} : { lastSyncedAt: new Date() }),
          firstTxAt,
          syncError: null,
        },
      });

      if (inserted > 0) {
        // Carteira OWN alimenta as métricas do usuário → invalida os snapshots.
        // Carteira SOURCE não entra nas métricas dele (só na atribuição) → não invalida.
        if (wallet.kind === WalletKind.OWN) {
          await this.invalidateSnapshots(wallet.userId, wallet.id);
        }
        // Trades novos (de qualquer kind) podem mudar a atribuição por fonte.
        const payload: WalletSyncedEvent = {
          userId: wallet.userId,
          walletId: wallet.id,
          kind: wallet.kind,
          inserted,
        };
        this.events.emit(WALLET_SYNCED_EVENT, payload);
      }
      this.logger.log(
        `Wallet ${wallet.id} (${wallet.kind}) ${morePages ? 'parcial (backfill continua)' : 'sincronizada'} ` +
          `(${inserted} trades novos, ${pages} páginas).`,
      );
    } catch (err: any) {
      await write.wallet.update({
        where: { id: wallet.id },
        data: {
          syncStatus: SyncStatus.ERROR,
          syncError: String(err?.message ?? err).slice(0, 500),
        },
      });
      throw err;
    }
  }

  /** Converte ProviderSwap → Trade e insere em lote (idempotente por unique). */
  private async persistSwaps(
    walletId: string,
    chainType: Wallet['chainType'],
    swaps: ProviderSwap[],
  ): Promise<number> {
    const data: Prisma.TradeCreateManyInput[] = swaps.map((s) => ({
      walletId,
      chainType,
      txHash: s.txHash,
      blockTime: s.blockTime,
      side: s.side,
      baseMint: s.baseMint,
      baseSymbol: s.baseSymbol ?? null,
      baseAmount: new Prisma.Decimal(s.baseAmount || '0'),
      quoteMint: s.quoteMint,
      quoteSymbol: s.quoteSymbol ?? null,
      quoteAmount: new Prisma.Decimal(s.quoteAmount || '0'),
      usdValue: new Prisma.Decimal(s.usdValue || '0'),
      priceUsd: new Prisma.Decimal(s.priceUsd || '0'),
      feeUsd: new Prisma.Decimal(s.feeUsd || '0'),
      feeNative: new Prisma.Decimal(s.feeNative || '0'),
      priceResolved: s.priceResolved ?? true,
      dexProgram: s.dexProgram ?? null,
      raw: (s.raw ?? undefined) as Prisma.InputJsonValue | undefined,
    }));

    const result = await this.prisma.getWriteClient().trade.createMany({
      data,
      skipDuplicates: true,
    });
    return result.count;
  }

  /** Invalida os snapshots de métrica da carteira e do portfólio do usuário. */
  private async invalidateSnapshots(
    userId: string,
    walletId: string,
  ): Promise<void> {
    await this.prisma.getWriteClient().metricSnapshot.deleteMany({
      where: { userId, OR: [{ walletId }, { scope: 'PORTFOLIO' }] },
    });
  }
}
