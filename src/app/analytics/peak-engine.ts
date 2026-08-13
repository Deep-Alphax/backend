import {
  ClosedPosition,
  CandlePoint,
  PeakMetrics,
  PerTradePeak,
  Benchmark,
  Survival,
} from './profile-metrics.types';

/**
 * Engine de PICO / CAPTURA (Bloco 2). Puro e determinístico: recebe posições
 * fechadas + candles por token e deriva "aproveitamento do topo", "posições que
 * devolveram" e o dataset "topo × saída". Sem I/O — testável com candles sintéticos.
 */

/** Uma posição "devolveu" se subiu ≥ +50% e a saída capturou < 50% desse topo. */
const GAVE_BACK_MIN_PEAK_MULTIPLE = 1.5;
const GAVE_BACK_MAX_CAPTURE = 0.5;

/** Nº de posições recentes expostas no gráfico topo × saída. */
const PER_TRADE_LIMIT = 20;

/** Maior `high` entre os candles cujo tempo cai em [entry, exit] (inclusive). */
function peakHighInWindow(
  candles: CandlePoint[] | undefined,
  entryMs: number,
  exitMs: number,
): number | null {
  if (!candles || candles.length === 0) return null;
  let peak: number | null = null;
  for (const c of candles) {
    if (c.timeMs < entryMs || c.timeMs > exitMs) continue;
    if (peak === null || c.high > peak) peak = c.high;
  }
  return peak;
}

export function computePeakMetrics(
  positions: ClosedPosition[],
  candlesByMint: Map<string, CandlePoint[]>,
): PeakMetrics {
  if (positions.length === 0) {
    return {
      available: false,
      coveragePct: 0,
      topCapturePct: null,
      gaveBackCount: 0,
      perTrade: [],
    };
  }

  let withData = 0;
  let gaveBackCount = 0;
  // Agregado ponderado por quantidade: Σ(saída−entrada)·qty / Σ(pico−entrada)·qty.
  let captureNum = 0;
  let captureDen = 0;

  const enriched = positions.map((p): PerTradePeak & { exitMs: number } => {
    const rawPeak = peakHighInWindow(
      candlesByMint.get(p.mint),
      p.entryTimeMs,
      p.exitTimeMs,
    );
    const entry = p.entryPriceUsd;
    const hasData = rawPeak !== null && entry > 0;

    // O pico nunca é menor que a própria entrada/saída (protege contra gaps de candle).
    const peak = hasData
      ? Math.max(rawPeak as number, entry, p.exitPriceUsd)
      : entry;
    const peakMultiple = entry > 0 ? peak / entry : 1;
    const exitMultiple = entry > 0 ? p.exitPriceUsd / entry : 1;

    let capturePct = 100;
    if (hasData && peak > entry) {
      const capture = (p.exitPriceUsd - entry) / (peak - entry);
      const clamped = Math.min(1, Math.max(0, capture));
      capturePct = Number((clamped * 100).toFixed(2));

      withData += 1;
      captureNum += (p.exitPriceUsd - entry) * p.qty;
      captureDen += (peak - entry) * p.qty;
      if (
        peakMultiple >= GAVE_BACK_MIN_PEAK_MULTIPLE &&
        clamped < GAVE_BACK_MAX_CAPTURE
      ) {
        gaveBackCount += 1;
      }
    }

    return {
      mint: p.mint,
      symbol: p.symbol,
      exitTime: new Date(p.exitTimeMs).toISOString(),
      exitMs: p.exitTimeMs,
      peakMultiple: Number(peakMultiple.toFixed(2)),
      exitMultiple: Number(exitMultiple.toFixed(2)),
      capturePct,
      tradingPnlUsd: p.tradingPnlUsd.toFixed(2),
      hasData,
    };
  });

  const perTrade = enriched
    .sort((a, b) => b.exitMs - a.exitMs)
    .slice(0, PER_TRADE_LIMIT)
    // `exitMs` é auxiliar de ordenação e não faz parte de PerTradePeak: descarta.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    .map(({ exitMs, ...rest }) => rest);

  return {
    available: withData > 0,
    coveragePct: Number(((withData / positions.length) * 100).toFixed(2)),
    topCapturePct:
      captureDen > 0
        ? Number(((captureNum / captureDen) * 100).toFixed(2))
        : null,
    gaveBackCount,
    perTrade,
  };
}

/**
 * Benchmark "capital medido em SOL": para cada dia da curva de capital (USD
 * acumulado), divide pelo preço do SOL naquele dia. `solPriceByDate` = mapa
 * YYYY-MM-DD → preço USD do SOL (do provider). Dias sem preço são omitidos.
 */
export function buildBenchmark(
  capitalPoints: { date: string; cumulativePnlUsd: string }[],
  solPriceByDate: Map<string, number>,
): Benchmark {
  const points = capitalPoints
    .map((p) => {
      const sol = solPriceByDate.get(p.date);
      if (!sol || sol <= 0) return null;
      return {
        date: p.date,
        portfolioInSol: (Number(p.cumulativePnlUsd) / sol).toFixed(4),
      };
    })
    .filter((p): p is { date: string; portfolioInSol: string } => p !== null);

  return { available: points.length > 0, points };
}

const WSOL = 'So11111111111111111111111111111111111111112';
/** Stablecoins Solana → convertidas para SOL ao preço do dia. */
const SOL_STABLES = new Set<string>([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

export interface SolTradeInput {
  side: 'BUY' | 'SELL';
  blockTimeMs: number;
  quoteMint: string;
  quoteAmount: string;
}

/**
 * "Capital medido em SOL" REAL: FLUXO LÍQUIDO de SOL do trading — Σ(SOL recebido nas
 * vendas) − Σ(SOL gasto nas compras), acumulado por dia dentro da janela. Reflete
 * quantos SOL o trading de fato colocou/tirou da carteira.
 *
 * Por que fluxo líquido e não FIFO casado: o histórico sincronizado não vai até a
 * primeira compra, então muitas vendas são de posições anteriores aos dados (parecem
 * "windfall" mas são trades reais). O FIFO descartaria essas vendas e subestimaria o
 * total em ordens de magnitude. O fluxo líquido conta todas as pernas de SOL de fato
 * movimentadas — bate com o SOL que o trader vê na carteira.
 *
 * Perna em SOL (WSOL) = valor direto; perna em stablecoin = convertida ao preço do
 * SOL no dia; quote desconhecida = 0 (não distorce). Janela filtra por blockTime.
 */
export function computeSolBenchmark(
  trades: SolTradeInput[],
  solPriceByDate: Map<string, number>,
  opts: { windowStart: Date | null; tzOffsetMinutes: number },
): Benchmark {
  const tz = opts.tzOffsetMinutes ?? 0;
  const windowStartMs = opts.windowStart ? opts.windowStart.getTime() : null;

  const dateOf = (ms: number): string =>
    new Date(ms + tz * 60_000).toISOString().slice(0, 10);
  const solOfLeg = (
    quoteMint: string,
    quoteAmount: string,
    date: string,
  ): number => {
    const q = Number(quoteAmount) || 0;
    if (quoteMint === WSOL) return q;
    if (SOL_STABLES.has(quoteMint)) {
      const price = solPriceByDate.get(date);
      return price && price > 0 ? q / price : 0;
    }
    return 0; // quote desconhecida → não distorce
  };

  // Fluxo líquido por dia: venda soma o SOL recebido, compra subtrai o SOL gasto.
  const dailySol = new Map<string, number>();
  for (const t of trades) {
    const inWindow = windowStartMs == null || t.blockTimeMs >= windowStartMs;
    if (!inWindow) continue;
    const date = dateOf(t.blockTimeMs);
    const sol = solOfLeg(t.quoteMint, t.quoteAmount, date);
    if (sol === 0) continue;
    const delta = t.side === 'SELL' ? sol : -sol;
    dailySol.set(date, (dailySol.get(date) ?? 0) + delta);
  }

  let cum = 0;
  const points = [...dailySol.keys()].sort().map((date) => {
    cum += dailySol.get(date) ?? 0;
    return { date, portfolioInSol: cum.toFixed(4) };
  });
  return { available: points.length > 0, points };
}

/** Agrega o status de liveness dos tokens negociados em uma taxa de sobrevida. */
export function computeSurvival(
  statuses: Array<'alive' | 'dead' | 'unknown'>,
): Survival {
  let alive = 0;
  let dead = 0;
  let unknown = 0;
  for (const s of statuses) {
    if (s === 'alive') alive += 1;
    else if (s === 'dead') dead += 1;
    else unknown += 1;
  }
  const known = alive + dead;
  return {
    available: known > 0,
    alivePct: known > 0 ? Number(((alive / known) * 100).toFixed(2)) : null,
    alive,
    dead,
    unknown,
  };
}
