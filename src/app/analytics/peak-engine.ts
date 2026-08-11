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
    return { available: false, coveragePct: 0, topCapturePct: null, gaveBackCount: 0, perTrade: [] };
  }

  let withData = 0;
  let gaveBackCount = 0;
  // Agregado ponderado por quantidade: Σ(saída−entrada)·qty / Σ(pico−entrada)·qty.
  let captureNum = 0;
  let captureDen = 0;

  const enriched = positions.map((p): PerTradePeak & { exitMs: number } => {
    const rawPeak = peakHighInWindow(candlesByMint.get(p.mint), p.entryTimeMs, p.exitTimeMs);
    const entry = p.entryPriceUsd;
    const hasData = rawPeak !== null && entry > 0;

    // O pico nunca é menor que a própria entrada/saída (protege contra gaps de candle).
    const peak = hasData ? Math.max(rawPeak as number, entry, p.exitPriceUsd) : entry;
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
      if (peakMultiple >= GAVE_BACK_MIN_PEAK_MULTIPLE && clamped < GAVE_BACK_MAX_CAPTURE) {
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
    .map(({ exitMs: _exitMs, ...rest }) => rest);

  return {
    available: withData > 0,
    coveragePct: Number(((withData / positions.length) * 100).toFixed(2)),
    topCapturePct: captureDen > 0 ? Number(((captureNum / captureDen) * 100).toFixed(2)) : null,
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
      return { date: p.date, portfolioInSol: (Number(p.cumulativePnlUsd) / sol).toFixed(4) };
    })
    .filter((p): p is { date: string; portfolioInSol: string } => p !== null);

  return { available: points.length > 0, points };
}

/** Agrega o status de liveness dos tokens negociados em uma taxa de sobrevida. */
export function computeSurvival(
  statuses: Array<"alive" | "dead" | "unknown">,
): Survival {
  let alive = 0;
  let dead = 0;
  let unknown = 0;
  for (const s of statuses) {
    if (s === "alive") alive += 1;
    else if (s === "dead") dead += 1;
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
