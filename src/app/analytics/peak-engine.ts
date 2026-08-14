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
  baseMint: string;
  baseAmount: string;
  quoteMint: string;
  quoteAmount: string;
}

/**
 * "Capital medido em SOL" REAL: PnL REALIZADO em SOL do trading, acumulado por dia
 * dentro da janela. É a MESMA filosofia da curva de capital em USD (PnL realizado
 * casado por FIFO), só que denominada em SOL — para as duas linhas do gráfico serem
 * comparáveis.
 *
 * Por dia (só vendas dentro da janela contribuem):
 *   - COMPRA: empilha um lote FIFO {qty, custoSol} e contribui 0 (deploy de capital
 *     NÃO é prejuízo — foi o que antes fazia a linha mergulhar no negativo no 1º dia).
 *   - VENDA: casa por FIFO contra os lotes. Contribui `proceedsSol − custoSol_casado`.
 *     A parte SEM lote (posição comprada antes do histórico sincronizado — "windfall",
 *     mas trade real) entra com custo 0, i.e. proceeds cheio; assim não se joga fora o
 *     SOL de fato recebido. Resultado por venda = `proceedsSol − custoCasado`.
 *
 * Só uma perda REAL de SOL num round-trip (vendeu por menos SOL do que comprou) faz a
 * curva descer — o que é verdade e legítimo. O total acumulado equivale ao fluxo
 * líquido de SOL quando não há posição aberta ao fim da janela; havendo, a posição
 * ainda em carteira conta como 0 (holding ≠ prejuízo), não como SOL "gasto".
 *
 * Perna em SOL (WSOL) = valor direto; perna em stablecoin = convertida ao preço do
 * SOL no dia; quote desconhecida = 0 (não distorce). Lotes são construídos com TODOS
 * os trades (a base de custo pode ser anterior à janela); só vendas na janela somam.
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

  // FIFO em SOL por token. Lote = {qty, solCost}. Constrói com TODOS os trades em ordem
  // cronológica (a base de custo pode ser anterior à janela e vendas pré-janela também
  // consomem lotes); realiza — soma no dia — só as vendas DENTRO da janela.
  const lots = new Map<string, Array<{ qty: number; solCost: number }>>();
  const dailySol = new Map<string, number>();
  for (const t of trades) {
    // Só pernas em SOL (WSOL) ou stablecoin participam. Quote desconhecida é ignorada
    // por completo (nem empilha lote, nem casa/realiza) — senão uma venda de quote
    // desconhecida realizaria `0 − custo` = perda espúria.
    if (t.quoteMint !== WSOL && !SOL_STABLES.has(t.quoteMint)) continue;

    const date = dateOf(t.blockTimeMs);
    const qty = Number(t.baseAmount) || 0;
    const sol = solOfLeg(t.quoteMint, t.quoteAmount, date);

    let lot = lots.get(t.baseMint);
    if (!lot) {
      lot = [];
      lots.set(t.baseMint, lot);
    }

    if (t.side === 'BUY') {
      if (qty > 0) lot.push({ qty, solCost: sol });
      continue;
    }

    // SELL — casa por FIFO consumindo os lotes (mesmo fora da janela, p/ não recasar).
    let remaining = qty;
    let matchedCost = 0;
    while (remaining > 1e-12 && lot.length > 0) {
      const l = lot[0];
      const take = Math.min(remaining, l.qty);
      const frac = l.qty > 0 ? take / l.qty : 0;
      matchedCost += l.solCost * frac;
      l.solCost -= l.solCost * frac;
      l.qty -= take;
      remaining -= take;
      if (l.qty <= 1e-12) lot.shift();
    }

    const inWindow = windowStartMs == null || t.blockTimeMs >= windowStartMs;
    if (!inWindow) continue;
    // Realizado = proceeds cheio − custo casado. A parte sem lote (windfall) já entra
    // por diferença: proceeds cobre 100% da qty vendida, custo cobre só o que casou.
    const realized = sol - matchedCost;
    dailySol.set(date, (dailySol.get(date) ?? 0) + realized);
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
