import {
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  Inject,
} from '@nestjs/common';
import {
  Chain,
  ChainType,
  MetricPeriod,
  MetricScope,
  Prisma,
  WalletKind,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { computePnl, computeClosedPositions } from './pnl-calculator';
import {
  computePeakMetrics,
  computeSolBenchmark,
  computeSurvival,
  type SolTradeInput,
} from './peak-engine';
import { TradeInput, PnlResult } from './pnl-types';
import {
  ProfileMetrics,
  PeakMetrics,
  Survival,
  Benchmark,
} from './profile-metrics.types';
import {
  MARKET_DATA_PROVIDER,
  MarketDataProvider,
  TokenSnapshot,
} from './providers/market-data-provider.interface';
import { CandleService, CandleFull } from './candle.service';
import { CacheRedisService } from '../../common/services/cache-redis.service';

/** Dias de janela por período. M12 = 365 (ano corrido). */
const PERIOD_DAYS: Record<MetricPeriod, number> = {
  [MetricPeriod.D30]: 30,
  [MetricPeriod.D90]: 90,
  [MetricPeriod.M12]: 365,
};

/** Mint do Wrapped SOL — série de preço p/ o benchmark "medido em SOL". */
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
/** Stablecoins Solana: única razão p/ precisar do preço do SOL no benchmark. */
const SOL_STABLE_MINTS = new Set<string>([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

/** Teto de tokens consultados no Bloco 2 por request (contém custo/rate-limit). */
const MAX_TOKENS_PER_REQUEST = 40;

/**
 * TTL (s) do cache do Bloco 2 (peaks+survival+benchmark). A chave carrega a
 * assinatura de trades → trades novos invalidam sozinhos; o TTL só limita a
 * validade dos dados externos (preço atual p/ survival). 30min equilibra
 * frescor × custo Moralis.
 */
const EXTRAS_TTL_SECONDS = 30 * 60;

const TRADE_SELECT = {
  blockTime: true,
  side: true,
  baseMint: true,
  baseSymbol: true,
  baseAmount: true,
  usdValue: true,
  priceUsd: true,
  feeUsd: true,
  priceResolved: true,
} satisfies Prisma.TradeSelect;

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    private readonly prisma: PrismaService,
    // Bloco 2 (histórico de preço) é OPCIONAL: sem provider/candles (ou sem
    // MORALIS_API_KEY), o endpoint devolve Bloco 1 + Bloco 2 vazio (available:false).
    @Optional()
    @Inject(MARKET_DATA_PROVIDER)
    private readonly provider?: MarketDataProvider,
    @Optional() private readonly candles?: CandleService,
    // Cache do Bloco 2 (fail-open): sem Redis, recomputa sempre (comportamento antigo).
    @Optional() private readonly cache?: CacheRedisService,
  ) {}

  /**
   * Saldo ATUAL (USD) das carteiras OWN do usuário — holdings on-chain × preço, via
   * provider. `walletId` escopa a uma carteira; sem ele, soma todas as OWN. Sem
   * provider (sem MORALIS_API_KEY) → null. Best-effort: falha por carteira vira 0.
   */
  async getWalletBalanceUsd(
    userId: string,
    walletId?: string,
  ): Promise<{ balanceUsd: string | null }> {
    if (!this.provider?.fetchWalletBalanceUsd) return { balanceUsd: null };

    const wallets = await this.prisma.getReadClient().wallet.findMany({
      where: {
        userId,
        kind: WalletKind.OWN,
        ...(walletId ? { id: walletId } : {}),
      },
      select: { chain: true, address: true },
    });
    if (wallets.length === 0) return { balanceUsd: null };

    const results = await Promise.all(
      wallets.map((w) =>
        this.provider!.fetchWalletBalanceUsd!(w.chain, w.address).catch(
          () => null,
        ),
      ),
    );
    const values = results.filter((v): v is string => v != null);
    if (values.length === 0) return { balanceUsd: null };

    const total = values.reduce((acc, v) => acc + Number(v), 0);
    return { balanceUsd: Number.isFinite(total) ? total.toFixed(2) : null };
  }

  /** Métricas de UMA carteira do usuário (Bloco 1, com cache por snapshot). */
  async walletMetrics(
    userId: string,
    walletId: string,
    period: MetricPeriod,
    tzOffsetMinutes: number,
  ): Promise<PnlResult> {
    const wallet = await this.prisma.getReadClient().wallet.findFirst({
      where: { id: walletId, userId, kind: WalletKind.OWN }, // ownership; fontes não têm métricas próprias
      select: { id: true },
    });
    if (!wallet) throw new NotFoundException('Carteira não encontrada');

    return this.computeCached(
      userId,
      MetricScope.WALLET,
      walletId,
      [walletId],
      period,
      tzOffsetMinutes,
    );
  }

  /**
   * Métricas do dashboard "Meu perfil": Bloco 1 (cache) + Bloco 2 (best-effort).
   * Sem `walletId` → agregado de TODAS as carteiras do usuário. Com `walletId` →
   * escopado a UMA carteira (mesmo shape), validando ownership.
   */
  async portfolioMetrics(
    userId: string,
    period: MetricPeriod,
    tzOffsetMinutes: number,
    walletId?: string,
  ): Promise<ProfileMetrics> {
    const read = this.prisma.getReadClient();

    let walletIds: string[];
    let scope: MetricScope;
    let scopeWalletId: string | null;

    if (walletId) {
      const owned = await read.wallet.findFirst({
        where: { id: walletId, userId, kind: WalletKind.OWN }, // ownership + só OWN
        select: { id: true },
      });
      if (!owned) throw new NotFoundException('Carteira não encontrada');
      walletIds = [walletId];
      scope = MetricScope.WALLET;
      scopeWalletId = walletId;
    } else {
      const wallets = await read.wallet.findMany({
        where: { userId, kind: WalletKind.OWN }, // só carteiras do usuário (exclui fontes)
        select: { id: true },
      });
      walletIds = wallets.map((w) => w.id);
      scope = MetricScope.PORTFOLIO;
      scopeWalletId = null;
    }

    const base = await this.computeCached(
      userId,
      scope,
      scopeWalletId,
      walletIds,
      period,
      tzOffsetMinutes,
    );

    // Bloco 2 nunca derruba a resposta: falha → extras vazios.
    const extras = await this.computeProfileExtras(
      walletIds,
      period,
      tzOffsetMinutes,
    ).catch((err) => {
      this.logger.warn(`Bloco 2 (histórico de preço) falhou: ${err?.message}`);
      return this.emptyExtras();
    });

    return { ...base, ...extras };
  }

  // ─────────────────────────── Bloco 1 (cache) ───────────────────────────

  private async computeCached(
    userId: string,
    scope: MetricScope,
    walletId: string | null,
    walletIds: string[],
    period: MetricPeriod,
    tzOffsetMinutes: number,
  ): Promise<PnlResult> {
    if (walletIds.length === 0) {
      return computePnl([], {
        windowStart: this.windowStart(period),
        tzOffsetMinutes,
      });
    }

    const read = this.prisma.getReadClient();

    const agg = await read.trade.aggregate({
      where: { walletId: { in: walletIds } },
      _count: { _all: true },
      _max: { createdAt: true },
    });
    // `v2` versiona o SHAPE do PnlResult: ao evoluir os campos (ex.: métricas de
    // perfil), muda o hash e invalida snapshots antigos sem migration manual.
    const tradesHash = `v4:${agg._count._all}:${agg._max.createdAt?.getTime() ?? 0}:${tzOffsetMinutes}`;

    const cached = await read.metricSnapshot.findFirst({
      where: { userId, walletId, scope, period },
      select: { id: true, tradesHash: true, data: true },
    });
    if (cached && cached.tradesHash === tradesHash) {
      return cached.data as unknown as PnlResult;
    }

    const rows = await read.trade.findMany({
      where: { walletId: { in: walletIds } },
      select: TRADE_SELECT,
      orderBy: { blockTime: 'asc' },
    });

    const result = computePnl(rows.map(toTradeInput), {
      windowStart: this.windowStart(period),
      tzOffsetMinutes,
    });
    const data = result as unknown as Prisma.InputJsonValue;
    const write = this.prisma.getWriteClient();

    if (cached) {
      await write.metricSnapshot.update({
        where: { id: cached.id },
        data: { tradesHash, data, computedAt: new Date() },
      });
    } else {
      await write.metricSnapshot.create({
        data: { userId, walletId, scope, period, tradesHash, data },
      });
    }

    return result;
  }

  // ─────────────────────────── Bloco 2 (histórico de preço) ───────────────────────────

  private emptyExtras(): {
    peaks: PeakMetrics;
    survival: Survival;
    benchmark: Benchmark;
  } {
    return {
      peaks: {
        available: false,
        coveragePct: 0,
        topCapturePct: null,
        gaveBackCount: 0,
        perTrade: [],
      },
      survival: {
        available: false,
        alivePct: null,
        alive: 0,
        dead: 0,
        unknown: 0,
      },
      benchmark: { available: false, points: [] },
    };
  }

  private async computeProfileExtras(
    walletIds: string[],
    period: MetricPeriod,
    tzOffsetMinutes: number,
  ): Promise<{ peaks: PeakMetrics; survival: Survival; benchmark: Benchmark }> {
    if (!this.provider || !this.candles || walletIds.length === 0)
      return this.emptyExtras();

    const read = this.prisma.getReadClient();

    // Cache do Bloco 2: assinatura barata (count + max createdAt) → trades novos trocam
    // a chave e invalidam sozinhos; TTL limita a validade dos preços externos (survival).
    // Evita o pior custo Moralis: recomputar candles/preços a cada request de dashboard.
    const sig = await read.trade.aggregate({
      where: { walletId: { in: walletIds } },
      _count: { _all: true },
      _max: { createdAt: true },
    });
    const cacheKey =
      `analytics:extras:v1:${period}:${tzOffsetMinutes}:` +
      `${this.hashWalletIds(walletIds)}:${sig._count._all}:${sig._max.createdAt?.getTime() ?? 0}`;

    const cached = await this.cache?.getJson<{
      peaks: PeakMetrics;
      survival: Survival;
      benchmark: Benchmark;
    }>(cacheKey);
    if (cached) return cached;

    const windowStart = this.windowStart(period);
    // Carrega trades COM a chain da carteira (candles/preço são por chain).
    const rows = await read.trade.findMany({
      where: { walletId: { in: walletIds } },
      select: {
        ...TRADE_SELECT,
        chainType: true,
        quoteMint: true,
        quoteAmount: true,
        wallet: { select: { chain: true } },
      },
      orderBy: { blockTime: 'asc' },
    });

    const positions = computeClosedPositions(rows.map(toTradeInput), {
      windowStart,
      tzOffsetMinutes,
    });
    if (positions.length === 0) return this.emptyExtras();

    // mint → chain (primeira ocorrência) e janela de hold por mint.
    const mintChain = new Map<string, { chainType: ChainType; chain: Chain }>();
    const spanByMint = new Map<string, { from: number; to: number }>();
    for (const r of rows) {
      if (!mintChain.has(r.baseMint)) {
        mintChain.set(r.baseMint, {
          chainType: r.chainType,
          chain: r.wallet.chain,
        });
      }
    }
    for (const p of positions) {
      const s = spanByMint.get(p.mint);
      if (!s) spanByMint.set(p.mint, { from: p.entryTimeMs, to: p.exitTimeMs });
      else {
        s.from = Math.min(s.from, p.entryTimeMs);
        s.to = Math.max(s.to, p.exitTimeMs);
      }
    }

    const mints = [...spanByMint.keys()].slice(0, MAX_TOKENS_PER_REQUEST);

    // Candles por token → pico/captura.
    const candlesByMint = new Map<string, CandleFull[]>();
    for (const mint of mints) {
      const cc = mintChain.get(mint);
      const span = spanByMint.get(mint);
      if (!cc || !span) continue;
      const candles = await this.candles.getCandles(
        cc.chainType,
        cc.chain,
        mint,
        new Date(span.from),
        new Date(span.to),
        '1h',
      );
      if (candles.length > 0) candlesByMint.set(mint, candles);
    }
    const peaks = computePeakMetrics(positions, candlesByMint);

    // Sobrevida: preço atual por token (>0 = vivo). EM LOTE por chain — 1 request/chain
    // (com cache por mint no provider) em vez de N chamadas single. Corta o custo Moralis.
    const mintsByChain = new Map<Chain, string[]>();
    for (const mint of mints) {
      const cc = mintChain.get(mint);
      if (!cc) continue;
      const arr = mintsByChain.get(cc.chain) ?? [];
      arr.push(mint);
      mintsByChain.set(cc.chain, arr);
    }
    const snapByMint = new Map<string, TokenSnapshot | null>();
    for (const [chain, chainMints] of mintsByChain) {
      try {
        const m = await this.provider.fetchTokenSnapshots(chain, chainMints);
        for (const [k, v] of m) snapByMint.set(k, v);
      } catch {
        // best-effort: mints dessa chain ficam 'unknown'
      }
    }
    const statuses: Array<'alive' | 'dead' | 'unknown'> = mints.map((mint) => {
      if (!mintChain.has(mint)) return 'unknown';
      const snap = snapByMint.get(mint);
      if (!snap) return 'unknown';
      return snap.priceUsd != null && Number(snap.priceUsd) > 0
        ? 'alive'
        : 'dead';
    });
    const survival = computeSurvival(statuses);

    // Benchmark "capital medido em SOL": FLUXO LÍQUIDO de SOL do trading (recebido nas
    // vendas − gasto nas compras). solByDate SÓ serve p/ converter pernas em stablecoin;
    // se não houver nenhuma na janela, evitamos por completo o fetch do candle do SOL.
    let benchmark: Benchmark = { available: false, points: [] };
    if (rows.length > 0) {
      const solTrades: SolTradeInput[] = rows.map((r) => ({
        side: r.side,
        blockTimeMs: r.blockTime.getTime(),
        quoteMint: r.quoteMint,
        quoteAmount: r.quoteAmount.toString(),
      }));

      const windowStartMs = windowStart ? windowStart.getTime() : null;
      const needsSolPrice = rows.some(
        (r) =>
          SOL_STABLE_MINTS.has(r.quoteMint) &&
          (windowStartMs == null || r.blockTime.getTime() >= windowStartMs),
      );

      const solByDate = new Map<string, number>();
      if (needsSolPrice) {
        const solCandles = await this.candles.getCandles(
          ChainType.SOLANA,
          Chain.SOLANA,
          WSOL_MINT,
          rows[0].blockTime,
          rows[rows.length - 1].blockTime,
          '1d',
        );
        for (const c of solCandles) {
          solByDate.set(new Date(c.timeMs).toISOString().slice(0, 10), c.close);
        }
      }

      benchmark = computeSolBenchmark(solTrades, solByDate, {
        windowStart,
        tzOffsetMinutes,
      });
    }

    const extras = { peaks, survival, benchmark };
    await this.cache?.setJson(cacheKey, extras, EXTRAS_TTL_SECONDS);
    return extras;
  }

  /** Hash estável e curto do conjunto de walletIds (ordem-insensível) p/ chave de cache. */
  private hashWalletIds(ids: string[]): string {
    const joined = [...ids].sort().join(',');
    let h = 5381;
    for (let i = 0; i < joined.length; i++) {
      h = ((h << 5) + h + joined.charCodeAt(i)) >>> 0; // djb2
    }
    return `${ids.length}_${h.toString(36)}`;
  }

  private windowStart(period: MetricPeriod): Date {
    const days = PERIOD_DAYS[period];
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  }
}

/** Row do Prisma → TradeInput do calculador (Decimal → string). */
function toTradeInput(r: {
  blockTime: Date;
  side: TradeInput['side'];
  baseMint: string;
  baseSymbol: string | null;
  baseAmount: Prisma.Decimal;
  usdValue: Prisma.Decimal;
  priceUsd: Prisma.Decimal;
  feeUsd: Prisma.Decimal;
  priceResolved: boolean;
}): TradeInput {
  return {
    blockTime: r.blockTime,
    side: r.side,
    baseMint: r.baseMint,
    baseSymbol: r.baseSymbol,
    baseAmount: r.baseAmount.toString(),
    usdValue: r.usdValue.toString(),
    priceUsd: r.priceUsd.toString(),
    feeUsd: r.feeUsd.toString(),
    priceResolved: r.priceResolved,
  };
}
