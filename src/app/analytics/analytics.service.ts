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
  buildBenchmark,
  computeSurvival,
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
} from './providers/market-data-provider.interface';
import { CandleService, CandleFull } from './candle.service';

/** Dias de janela por período. M12 = 365 (ano corrido). */
const PERIOD_DAYS: Record<MetricPeriod, number> = {
  [MetricPeriod.D30]: 30,
  [MetricPeriod.D90]: 90,
  [MetricPeriod.M12]: 365,
};

/** Mint do Wrapped SOL — série de preço p/ o benchmark "medido em SOL". */
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** Teto de tokens consultados no Bloco 2 por request (contém custo/rate-limit). */
const MAX_TOKENS_PER_REQUEST = 40;

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
  ) {}

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
      base,
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
    base: PnlResult,
  ): Promise<{ peaks: PeakMetrics; survival: Survival; benchmark: Benchmark }> {
    if (!this.provider || !this.candles || walletIds.length === 0)
      return this.emptyExtras();

    const windowStart = this.windowStart(period);
    // Carrega trades COM a chain da carteira (candles/preço são por chain).
    const rows = await this.prisma.getReadClient().trade.findMany({
      where: { walletId: { in: walletIds } },
      select: {
        ...TRADE_SELECT,
        chainType: true,
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

    // Sobrevida: preço atual por token (>0 = vivo).
    const statuses: Array<'alive' | 'dead' | 'unknown'> = [];
    for (const mint of mints) {
      const cc = mintChain.get(mint);
      if (!cc) {
        statuses.push('unknown');
        continue;
      }
      try {
        const snap = await this.provider.fetchTokenSnapshot(cc.chain, mint);
        if (!snap) statuses.push('unknown');
        else
          statuses.push(
            snap.priceUsd != null && Number(snap.priceUsd) > 0
              ? 'alive'
              : 'dead',
          );
      } catch {
        statuses.push('unknown');
      }
    }
    const survival = computeSurvival(statuses);

    // Benchmark: preço diário do SOL → capital acumulado medido em SOL.
    let benchmark: Benchmark = { available: false, points: [] };
    const points = base.capital.points;
    if (points.length > 0) {
      const from = new Date(`${points[0].date}T00:00:00Z`);
      const to = new Date(`${points[points.length - 1].date}T23:59:59Z`);
      const solCandles = await this.candles.getCandles(
        ChainType.SOLANA,
        Chain.SOLANA,
        WSOL_MINT,
        from,
        to,
        '1d',
      );
      const solByDate = new Map<string, number>();
      for (const c of solCandles) {
        solByDate.set(new Date(c.timeMs).toISOString().slice(0, 10), c.close);
      }
      benchmark = buildBenchmark(points, solByDate);
    }

    return { peaks, survival, benchmark };
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
