import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ChainType, Prisma, SwapSource, SyncStatus, Wallet } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { chainTypeOf } from '../../wallets/wallet-address.util';
import {
  FetchSwapsResult,
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

  /**
   * Janela do backfill: NÃO puxamos histórico além disto (o dashboard é D30). Piso de
   * data aplicado ao provider → ele para de paginar ao cruzar a fronteira. Corta
   * drasticamente páginas/custo em carteiras antigas. Configurável por env; default 30d.
   */
  private static readonly BACKFILL_WINDOW_MS =
    Number(process.env.WALLET_BACKFILL_WINDOW_MS) || 30 * 24 * 60 * 60 * 1000;

  /** Evita sobreposição de execuções do cron (tick lento não empilha). */
  private running = false;

  /**
   * Teto de lotes ao rodar o backfill "até completar" (via `ensureFresh`, disparo
   * imediato ao catalogar). Cada lote = MAX_PAGES_PER_RUN páginas → 500 × 20 × 100
   * ≈ 1M swaps. Só uma trava anti-loop; carteiras reais terminam MUITO antes.
   */
  private static readonly MAX_BACKFILL_BATCHES = 500;
  /**
   * Backfills completos SIMULTÂNEOS (disparo imediato). Protege o rate limit/custo
   * do provider quando várias carteiras são adicionadas de uma vez — o excedente
   * roda 1 lote e cai no cron p/ continuar. O cron segue como rede de segurança.
   */
  private static readonly MAX_CONCURRENT_BACKFILLS = 2;
  private activeBackfills = 0;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MARKET_DATA_PROVIDER) private readonly provider: MarketDataProvider,
    private readonly events: EventEmitter2,
    private readonly config: ConfigService,
  ) {}

  /**
   * Fonte de swaps default (sem pin) para uma chain: EVM→Moralis; Solana→Birdeye
   * quando há `BIRDEYE_API_KEY`, senão Helius. É só o PALPITE inicial — o 1º sync
   * pina a fonte de fato (com fallback Birdeye→Helius se o Birdeye falhar).
   */
  private defaultSource(chain: Wallet['chain']): SwapSource {
    if (chainTypeOf(chain) !== ChainType.SOLANA) return SwapSource.MORALIS;
    return this.config.get<string>('BIRDEYE_API_KEY')
      ? SwapSource.BIRDEYE
      : SwapSource.HELIUS;
  }

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
        // Roda até completar (sem o gap de 1 min entre lotes) — o limite de
        // concorrência interno protege o provider; o resto cai no próximo tick.
        await this.runToCompletion(wallet).catch((err) =>
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
      // Dois modos, ambos LIMITADOS à janela de BACKFILL_WINDOW_MS (30 dias):
      //  - BACKFILL: cursor pendente OU nunca sincronizou. Pagina do mais novo p/ o
      //    mais antigo até cruzar o piso da janela — não puxa histórico além disso.
      //  - INCREMENTAL: após backfill (lastSyncedAt setado), busca só o novo desde então.
      // O piso efetivo é o MAIS RECENTE entre (30d atrás) e lastSyncedAt: nunca puxamos
      // mais que 30 dias, e num refresh só o delta desde o último sync.
      const windowFloor = new Date(Date.now() - WalletSyncService.BACKFILL_WINDOW_MS);
      const resumingBackfill = wallet.syncCursor != null;
      const sinceBlockTime = new Date(
        Math.max(windowFloor.getTime(), wallet.lastSyncedAt?.getTime() ?? 0),
      );

      let cursor: string | null = wallet.syncCursor ?? null;
      let pages = 0;
      let inserted = 0;
      let minBlockTime: Date | null = null;

      // Fonte PINADA (imutável) ou o palpite default do 1º sync. Nunca mistura
      // fontes na mesma carteira (evita a mesma tx virar linhas duplicadas).
      const pinnedSource = wallet.syncSource;
      let source = pinnedSource ?? this.defaultSource(wallet.chain);

      const mode = resumingBackfill
        ? 'backfill(resume)'
        : wallet.lastSyncedAt
          ? 'incremental'
          : 'backfill(window)';
      this.logger.log(
        `Sync START wallet ${wallet.id} (${wallet.chain}) addr=${wallet.address} ` +
          `modo=${mode} fonte=${source}${pinnedSource ? '(pin)' : ''} ` +
          `sinceBlockTime=${sinceBlockTime?.toISOString() ?? 'null'} cursor=${cursor ? 'sim' : 'não'}`,
      );

      do {
        let result: FetchSwapsResult;
        try {
          result = await this.provider.fetchSwaps({
            chain: wallet.chain,
            address: wallet.address,
            source,
            cursor,
            sinceBlockTime,
            limit: WalletSyncService.PAGE_SIZE,
          });
        } catch (err) {
          // Fallback SÓ no 1º sync (sem pin), na 1ª página, Birdeye→Helius. Depois
          // de pinada, a fonte não troca — o erro sobe e o cron retenta a mesma.
          if (
            !pinnedSource &&
            pages === 0 &&
            cursor == null &&
            source === SwapSource.BIRDEYE
          ) {
            this.logger.warn(
              `Birdeye falhou no 1º sync de ${wallet.id} → fallback p/ Helius: ${(err as Error)?.message}`,
            );
            source = SwapSource.HELIUS;
            result = await this.provider.fetchSwaps({
              chain: wallet.chain,
              address: wallet.address,
              source,
              cursor,
              sinceBlockTime,
              limit: WalletSyncService.PAGE_SIZE,
            });
          } else {
            throw err;
          }
        }

        // Pina a fonte na 1ª página bem-sucedida do 1º sync (imutável daqui pra frente).
        if (!pinnedSource && pages === 0) {
          await write.wallet.update({
            where: { id: wallet.id },
            data: { syncSource: source },
          });
        }

        const { swaps, nextCursor } = result;

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

    void this.runToCompletion(w).catch((e) =>
      this.logger.warn(
        `ensureFresh sync falhou p/ wallet ${walletId}: ${e?.message}`,
      ),
    );
    return true;
  }

  /**
   * Roda o backfill de UMA carteira ATÉ COMPLETAR (lotes de MAX_PAGES_PER_RUN em
   * sequência, sem o gap de 1 min do cron) — a carteira recém-adicionada sincroniza
   * o mais rápido que o provider permitir. Reusa `syncWallet` (persist/estado/eventos/
   * retry). Para quando o status sai de PENDING (SYNCED/ERROR), a carteira é
   * desativada, ou o teto de lotes é atingido.
   *
   * Concorrência limitada (`MAX_CONCURRENT_BACKFILLS`): acima do teto, roda só 1 lote
   * e deixa o cron continuar — protege o custo/rate limit do provider. O cron
   * (`drainPending`) segue como rede de segurança (retoma PENDING órfão pós-restart).
   */
  private async runToCompletion(wallet: Wallet): Promise<void> {
    // Acima do teto de concorrência → 1 lote e sai (o cron drena o resto).
    if (this.activeBackfills >= WalletSyncService.MAX_CONCURRENT_BACKFILLS) {
      await this.syncWallet(wallet);
      return;
    }
    this.activeBackfills += 1;
    try {
      let current: Wallet | null = wallet;
      for (let i = 0; i < WalletSyncService.MAX_BACKFILL_BATCHES && current; i++) {
        await this.syncWallet(current);
        const fresh = await this.prisma
          .getReadClient()
          .wallet.findUnique({ where: { id: wallet.id } });
        // Continua só enquanto ainda há backfill pendente desta carteira.
        current =
          fresh && fresh.isActive && fresh.syncStatus === SyncStatus.PENDING
            ? fresh
            : null;
      }
    } finally {
      this.activeBackfills -= 1;
    }
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
