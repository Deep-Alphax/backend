import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, SyncStatus, Wallet } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  MARKET_DATA_PROVIDER,
  MarketDataProvider,
  ProviderSwap,
  ProviderRequestError,
} from '../providers/market-data-provider.interface';

/** Nome do evento emitido quando uma carteira sincroniza com trades novos. */
export const WALLET_SYNCED_EVENT = 'wallet.synced';

/**
 * Payload de `wallet.synced`. Consumido pelo SourcesModule p/ reatribuição. Como a
 * carteira é COMPARTILHADA, o evento é emitido UMA VEZ POR usuário que a cataloga
 * (cada um recomputa a própria atribuição).
 */
export interface WalletSyncedEvent {
  userId: string;
  walletId: string;
  inserted: number;
}

/**
 * Evento de MUDANÇA DE ESTADO do sync, destinado ao cliente (empurrado via WebSocket
 * pelo EventsGateway). Diferente de `wallet.synced` (que só dispara quando há trades
 * novos), este dispara SEMPRE que o sync termina — inclusive com 0 trades ou erro —
 * para o dashboard sair do estado "sincronizando" em tempo real, sem polling. Emitido
 * por usuário que cataloga a carteira (fan-out — a carteira é compartilhada).
 */
export const WALLET_SYNC_STATE_EVENT = 'wallet.sync.state';
export interface WalletSyncStateEvent {
  userId: string;
  walletId: string;
  status: SyncStatus;
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

  /**
   * Auto-recuperação de falha TRANSITÓRIA (401/429/5xx/timeout): o cron retenta a
   * carteira em ERROR até este teto de tentativas consecutivas, com backoff crescente.
   * Atingido o teto (ou falha PERMANENTE de dado), para de retentar — evita queimar
   * CU do provider num loop, crítico quando a conta está no limite.
   */
  private static readonly MAX_SYNC_ATTEMPTS = 6;
  /** Backoff por tentativa, em minutos (satura no último). */
  private static readonly RETRY_BACKOFF_MIN = [1, 2, 5, 15, 30, 60];

  /**
   * Limite de frescor: ao ABRIR uma carteira já sincronizada, só dispara um sync
   * incremental (preenche a lacuna) se passou disto desde o último sync. Menor =
   * mais fresco/mais chamadas; maior = mais barato. Configurável por env; default 1 dia.
   */
  private static readonly STALE_MS =
    Number(process.env.WALLET_STALE_MS) || 24 * 60 * 60 * 1000;

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
      // Drena PENDING + carteiras em ERROR cujo backoff venceu (auto-recuperação de
      // falha transitória), respeitando o teto de tentativas p/ não insistir à toa.
      const pending = await this.prisma.getReadClient().wallet.findMany({
        where: {
          isActive: true,
          OR: [
            { syncStatus: SyncStatus.PENDING },
            {
              syncStatus: SyncStatus.ERROR,
              nextRetryAt: { not: null, lte: new Date() },
              syncAttempts: { lt: WalletSyncService.MAX_SYNC_ATTEMPTS },
            },
          ],
        },
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

      const mode = resumingBackfill
        ? 'backfill(resume)'
        : sinceBlockTime
          ? 'incremental'
          : 'backfill(full)';
      this.logger.log(
        `Sync START wallet ${wallet.id} (${wallet.chain}) addr=${wallet.address} ` +
          `modo=${mode} sinceBlockTime=${sinceBlockTime?.toISOString() ?? 'null'} cursor=${cursor ? 'sim' : 'não'}`,
      );

      do {
        const { swaps, nextCursor } = await this.provider.fetchSwaps({
          chain: wallet.chain,
          address: wallet.address,
          cursor,
          sinceBlockTime,
          limit: WalletSyncService.PAGE_SIZE,
        });

        let insertedThisPage = 0;
        if (swaps.length > 0) {
          insertedThisPage = await this.persistSwaps(
            wallet.id,
            wallet.chainType,
            swaps,
          );
          inserted += insertedThisPage;
          for (const s of swaps) {
            if (!minBlockTime || s.blockTime < minBlockTime)
              minBlockTime = s.blockTime;
          }
        }

        pages += 1;
        this.logger.log(
          `  wallet ${wallet.id} página ${pages}: ${swaps.length} swaps do provider → ` +
            `+${insertedThisPage} novos (nextCursor=${nextCursor ? 'sim' : 'não'})`,
        );
        cursor = nextCursor;
      } while (cursor && pages < WalletSyncService.MAX_PAGES_PER_RUN);

      // Sinaliza o caso mais comum de "dashboard zerado": o provider não tem swaps
      // p/ este endereço (carteira vazia/errada, ou DEX não indexada pelo provider).
      if (inserted === 0 && wallet.lastSyncedAt == null && !cursor) {
        this.logger.warn(
          `Wallet ${wallet.id} (${wallet.chain}) addr=${wallet.address}: provider retornou 0 swaps ` +
            `no backfill inicial — sem histórico de swaps indexado para este endereço.`,
        );
      }

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
          // Progresso → zera o estado de retry (uma página OK já indica que o provider voltou).
          syncAttempts: 0,
          nextRetryAt: null,
        },
      });

      // Fan-out: a carteira é COMPARTILHADA → todo usuário que a cataloga precisa ter
      // o cache invalidado, a atribuição recomputada e o WebSocket empurrado.
      const userIds = await this.catalogUserIds(wallet.id);
      const status = morePages ? SyncStatus.PENDING : SyncStatus.SYNCED;

      if (inserted > 0 && userIds.length > 0) {
        await this.invalidateSnapshots(userIds, wallet.id);
        // Trades novos podem mudar a atribuição por fonte de CADA catalogador.
        for (const userId of userIds) {
          this.events.emit(WALLET_SYNCED_EVENT, {
            userId,
            walletId: wallet.id,
            inserted,
          } satisfies WalletSyncedEvent);
        }
      }
      // Estado do sync → cliente (WebSocket). SEMPRE que termina (mesmo 0 trades),
      // para o dashboard de cada catalogador reagir em tempo real.
      for (const userId of userIds) {
        this.events.emit(WALLET_SYNC_STATE_EVENT, {
          userId,
          walletId: wallet.id,
          status,
          inserted,
        } satisfies WalletSyncStateEvent);
      }
      this.logger.log(
        `Wallet ${wallet.id} ${morePages ? 'parcial (backfill continua)' : 'sincronizada'} ` +
          `(${inserted} trades novos, ${pages} páginas, ${userIds.length} catalogadores).`,
      );
    } catch (err: any) {
      // Classifica a falha: transitória (retenta com backoff) vs permanente (desiste).
      const status =
        err instanceof ProviderRequestError ? err.status : undefined;
      const transient = WalletSyncService.isTransient(status);
      const attempts = (wallet.syncAttempts ?? 0) + 1;
      const willRetry =
        transient && attempts < WalletSyncService.MAX_SYNC_ATTEMPTS;
      const nextRetryAt = willRetry
        ? new Date(Date.now() + WalletSyncService.backoffMs(attempts))
        : null; // permanente ou teto atingido → só resync manual destrava

      await write.wallet.update({
        where: { id: wallet.id },
        data: {
          syncStatus: SyncStatus.ERROR,
          syncError: String(err?.message ?? err).slice(0, 500),
          syncAttempts: attempts,
          nextRetryAt,
        },
      });

      // Estado ERROR → cliente (WebSocket), p/ tirar o dashboard do "sincronizando".
      // Fan-out p/ todos os catalogadores da carteira compartilhada.
      const userIds = await this.catalogUserIds(wallet.id);
      for (const userId of userIds) {
        this.events.emit(WALLET_SYNC_STATE_EVENT, {
          userId,
          walletId: wallet.id,
          status: SyncStatus.ERROR,
          inserted: 0,
        } satisfies WalletSyncStateEvent);
      }

      this.logger.warn(
        `Sync wallet ${wallet.id} ERROR (status=${status ?? 'n/a'}, ` +
          `${transient ? 'transitório' : 'permanente'}, tentativa ${attempts}/${WalletSyncService.MAX_SYNC_ATTEMPTS}) → ` +
          `${willRetry ? `retry em ${nextRetryAt?.toISOString()}` : 'sem auto-retry'}: ${err?.message}`,
      );
      throw err;
    }
  }

  /**
   * Falha transitória (vale retentar): erro de rede/timeout (sem status), 408/429,
   * 401/403 (Moralis devolve assim ao estourar o limite de CU) e 5xx. Falha
   * permanente de dado (400/404/422 — ex.: endereço inválido) NÃO deve retentar.
   */
  private static isTransient(status?: number): boolean {
    if (status == null) return true;
    if (status === 408 || status === 429) return true;
    if (status === 401 || status === 403) return true;
    return status >= 500;
  }

  /** Backoff crescente (ms) por número de tentativas; satura no último degrau. */
  private static backoffMs(attempts: number): number {
    const table = WalletSyncService.RETRY_BACKOFF_MIN;
    const idx = Math.min(Math.max(attempts - 1, 0), table.length - 1);
    return table[idx] * 60_000;
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

  /**
   * "Portão de frescor": ao ABRIR/selecionar uma carteira, dispara um sync incremental
   * (preenche a lacuna) se ela nunca foi sincronizada OU está stale além de STALE_MS.
   * Se já está sincronizando/na fila, não faz nada (reusa o que vier). Fire-and-forget:
   * responde já; o WebSocket avisa quando os trades novos entram. Retorna se disparou.
   */
  async ensureFresh(walletId: string): Promise<boolean> {
    const w = await this.prisma.getReadClient().wallet.findUnique({
      where: { id: walletId },
    });
    if (!w || !w.isActive) return false;
    // Já rodando/enfileirada → o resultado será reusado; não redispara.
    if (
      w.syncStatus === SyncStatus.SYNCING ||
      w.syncStatus === SyncStatus.PENDING
    ) {
      return false;
    }
    const neverSynced = w.lastSyncedAt == null && w.syncCursor == null;
    const stale =
      w.lastSyncedAt != null &&
      Date.now() - w.lastSyncedAt.getTime() > WalletSyncService.STALE_MS;
    if (!neverSynced && !stale) return false;

    void this.syncWallet(w).catch((e) =>
      this.logger.warn(
        `ensureFresh sync falhou p/ wallet ${walletId}: ${e?.message}`,
      ),
    );
    return true;
  }

  /** userIds de todos os usuários que catalogam a carteira (fan-out compartilhado). */
  private async catalogUserIds(walletId: string): Promise<string[]> {
    const rows = await this.prisma.getReadClient().walletCatalog.findMany({
      where: { walletId },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  /** Invalida os snapshots de métrica dos usuários que catalogam a carteira. */
  private async invalidateSnapshots(
    userIds: string[],
    walletId: string,
  ): Promise<void> {
    if (userIds.length === 0) return;
    await this.prisma.getWriteClient().metricSnapshot.deleteMany({
      where: {
        userId: { in: userIds },
        OR: [{ walletId }, { scope: 'PORTFOLIO' }],
      },
    });
  }
}
