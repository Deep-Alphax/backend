import { Prisma, TradeSide } from '@prisma/client';
import {
  TradeInput,
  PnlOptions,
  PnlResult,
  HourBucket,
  DayBucket,
  WeekdayBlockCell,
  TokenBreakdown,
  OutcomeKey,
  OutcomeBucket,
  ProfitConcentration,
  ProfitConcentrationBucket,
  WinRate,
  CapitalCurve,
  BankrollMetrics,
} from './pnl-types';
import { ClosedPosition } from './profile-metrics.types';

/** Uma posição fechada (venda casada com lotes reais), dentro da janela. */
interface ClosedSell {
  tradingPnl: Dec; // PnL de trading da parte casada
  multiple: number; // preço de venda ÷ custo médio dos lotes casados
}

const D = Prisma.Decimal;
type Dec = Prisma.Decimal;
const ZERO = new D(0);

const METHOD =
  'PnL realizado por base de custo FIFO (venda casada contra os lotes de compra mais antigos), ' +
  'denominado em USD via preço do provider no instante do bloco. Hold time = média ponderada por ' +
  'quantidade entre a venda e os lotes casados. Vendas sem lote de compra conhecido usam base de ' +
  'custo 0 e reduzem a confiança. PnL bruto de taxas; net = PnL − taxas.';

/** Lote de compra FIFO (base de custo + cronômetro de hold). */
interface Lot {
  qty: Dec;
  unitCost: Dec; // USD por unidade
  time: number; // epoch ms
}

interface TokenState {
  symbol: string | null;
  lots: Lot[];
  trades: number;
  buyCount: number;
  buyUsd: Dec;
  sellUsd: Dec;
  realized: Dec; // bruto (trading + windfall)
  windfall: Dec; // proceeds de vendas sem base de custo
  fees: Dec;
  holdWeightSum: number; // Σ (qtyCasada * segundos)
  holdQtySum: number; // Σ qtyCasada
}

function newTokenState(symbol: string | null): TokenState {
  return {
    symbol,
    lots: [],
    trades: 0,
    buyCount: 0,
    buyUsd: new D(0),
    sellUsd: new D(0),
    realized: new D(0),
    windfall: new D(0),
    fees: new D(0),
    holdWeightSum: 0,
    holdQtySum: 0,
  };
}

/**
 * Aplica offset de fuso e devolve {hour, date, weekday} "locais" (tratados como
 * UTC deslocado). `weekday`: 0=Seg … 6=Dom (getUTCDay é 0=Dom → +6 %7).
 */
function localParts(
  blockTime: Date,
  tzOffsetMinutes: number,
): { hour: number; date: string; weekday: number } {
  const shifted = new Date(blockTime.getTime() + tzOffsetMinutes * 60_000);
  return {
    hour: shifted.getUTCHours(),
    date: shifted.toISOString().slice(0, 10),
    weekday: (shifted.getUTCDay() + 6) % 7,
  };
}

/**
 * Casa uma venda contra os lotes FIFO do token (muta os lotes). Devolve o PnL
 * realizado, a quantidade casada, o hold ponderado por qty (Σ qty*segundos) e se
 * sobrou quantidade sem lote (base de custo desconhecida → ganho puro + flag).
 */
function matchSell(
  st: TokenState,
  sellQty: Dec,
  sellPrice: Dec,
  sellTimeMs: number,
): {
  matchedRealized: Dec; // PnL de trading (parte casada com lotes reais)
  zeroBasisProceeds: Dec; // proceeds da parte sem lote (windfall)
  matchedQty: number;
  costBasisUsd: Dec; // Σ (custo unitário * qty casada) — base do múltiplo de saída
  holdWeight: number;
  unmatched: boolean;
} {
  let remaining = sellQty;
  let matchedRealized = ZERO;
  let matchedQty = 0;
  let costBasisUsd = ZERO;
  let holdWeight = 0;

  while (remaining.gt(0) && st.lots.length > 0) {
    const lot = st.lots[0];
    const take = Prisma.Decimal.min(remaining, lot.qty);
    matchedRealized = matchedRealized.plus(sellPrice.minus(lot.unitCost).times(take));
    costBasisUsd = costBasisUsd.plus(lot.unitCost.times(take));
    const takeNum = Number(take.toString());
    const holdSec = Math.max(0, (sellTimeMs - lot.time) / 1000);
    holdWeight += takeNum * holdSec;
    matchedQty += takeNum;
    lot.qty = lot.qty.minus(take);
    remaining = remaining.minus(take);
    if (lot.qty.lte(0)) st.lots.shift();
  }

  let unmatched = false;
  let zeroBasisProceeds = ZERO;
  if (remaining.gt(0)) {
    // Sem lote → não é lucro de trading; é proceeds "de graça" (windfall), reportado à parte.
    zeroBasisProceeds = sellPrice.times(remaining);
    unmatched = true;
  }
  return { matchedRealized, zeroBasisProceeds, matchedQty, costBasisUsd, holdWeight, unmatched };
}

/** Classifica uma posição fechada pelo múltiplo realizado (ver OutcomeKey). */
function outcomeOf(multiple: number): OutcomeKey {
  if (multiple < 0.1) return 'rugpull';
  if (multiple < 1) return 'stop_loss';
  if (multiple < 2) return 'x1_2';
  if (multiple < 5) return 'x2_5';
  return 'x5_plus';
}

/**
 * Calcula todas as métricas da janela. Processa TODOS os trades em ordem
 * cronológica para manter a base de custo (lotes de compra podem ser anteriores
 * à janela), mas só ATRIBUI métricas aos trades cujo blockTime cai na janela.
 */
export function computePnl(trades: TradeInput[], opts: PnlOptions): PnlResult {
  const tz = opts.tzOffsetMinutes ?? 0;
  const windowStart = opts.windowStart;
  const inWindow = (t: TradeInput) => !windowStart || t.blockTime >= windowStart;

  const sorted = [...trades].sort((a, b) => a.blockTime.getTime() - b.blockTime.getTime());

  const tokens = new Map<string, TokenState>();
  const hourly = Array.from({ length: 24 }, () => ({ trades: 0, realized: new D(0) }));
  const days = new Map<string, { trades: number; realized: Dec }>();
  // Grade 7 dias × 6 blocos de 4h (heatmap "Quando e onde").
  const weekGrid = Array.from({ length: 7 }, () =>
    Array.from({ length: 6 }, () => ({ trades: 0, realized: new D(0) })),
  );

  let totalTrades = 0;
  let buys = 0;
  let sells = 0;
  let realizedTotal = ZERO; // bruto = trading + windfall (reconcilia com sum(daily))
  let tradingTotal = ZERO; // PnL de trading (vendas casadas)
  let windfallTotal = ZERO; // proceeds sem base de custo
  let feesTotal = ZERO;
  let volumeTotal = ZERO;
  let priceResolvedCount = 0;
  let unmatchedSellCount = 0;

  let holdWinWeight = 0;
  let holdWinQty = 0;
  let holdLossWeight = 0;
  let holdLossQty = 0;

  let prevWasLoss = false;
  let afterLossCount = 0;
  let afterLossWinners = 0;
  let afterLossLosers = 0;
  let afterLossRealized = ZERO;

  // Posições fechadas (vendas casadas na janela) → win rate, concentração, desfechos.
  const closedSells: ClosedSell[] = [];

  // Bankroll = pico do capital líquido investido (Σ compras − Σ vendas, na janela).
  let deployedNet = ZERO;
  let peakDeployed = ZERO;

  for (const t of sorted) {
    let st = tokens.get(t.baseMint);
    if (!st) {
      st = newTokenState(t.baseSymbol);
      tokens.set(t.baseMint, st);
    }
    if (t.baseSymbol && !st.symbol) st.symbol = t.baseSymbol;

    const qty = new D(t.baseAmount || '0');
    const price = new D(t.priceUsd || '0');
    const usd = new D(t.usdValue || '0');
    const fee = new D(t.feeUsd || '0');
    const within = inWindow(t);

    // PnL realizado DESTE trade (0 para compras).
    let realizedThis = ZERO;

    if (t.side === TradeSide.BUY) {
      st.lots.push({ qty, unitCost: price, time: t.blockTime.getTime() });
      if (within) {
        st.trades += 1;
        st.buyCount += 1;
        st.buyUsd = st.buyUsd.plus(usd);
        st.fees = st.fees.plus(fee);
      }
    } else {
      const m = matchSell(st, qty, price, t.blockTime.getTime());
      // realizedThis (bruto) alimenta buckets/dia/after-loss → sum(daily) reconcilia com realizedTotal.
      realizedThis = m.matchedRealized.plus(m.zeroBasisProceeds);
      if (within) {
        st.trades += 1;
        st.sellUsd = st.sellUsd.plus(usd);
        st.fees = st.fees.plus(fee);
        st.realized = st.realized.plus(realizedThis);
        st.windfall = st.windfall.plus(m.zeroBasisProceeds);
        st.holdWeightSum += m.holdWeight;
        st.holdQtySum += m.matchedQty;
        tradingTotal = tradingTotal.plus(m.matchedRealized);
        windfallTotal = windfallTotal.plus(m.zeroBasisProceeds);
        if (m.unmatched) unmatchedSellCount += 1;
        // Classificação winner/loser do HOLD usa só a parte casada (a única com cronômetro).
        if (m.matchedQty > 0) {
          if (m.matchedRealized.gt(0)) {
            holdWinWeight += m.holdWeight;
            holdWinQty += m.matchedQty;
          } else {
            holdLossWeight += m.holdWeight;
            holdLossQty += m.matchedQty;
          }

          // Múltiplo de saída = preço de venda ÷ custo médio dos lotes casados.
          // Sem custo (lote a preço 0): infere pelo sinal do PnL (lucro → x5+).
          const avgCost = m.costBasisUsd.div(m.matchedQty);
          const multiple = avgCost.gt(0)
            ? Number(price.div(avgCost).toString())
            : m.matchedRealized.gt(0)
              ? Number.POSITIVE_INFINITY
              : 0;
          closedSells.push({ tradingPnl: m.matchedRealized, multiple });
        }
      }
    }

    if (!within) continue;

    // ── Atribuição de métricas da janela ──
    totalTrades += 1;
    if (t.side === TradeSide.BUY) buys += 1;
    else sells += 1;
    if (t.priceResolved) priceResolvedCount += 1;
    feesTotal = feesTotal.plus(fee);
    volumeTotal = volumeTotal.plus(usd);
    realizedTotal = realizedTotal.plus(realizedThis);

    // Capital líquido em risco: compra soma o notional, venda subtrai; o pico é o bankroll.
    deployedNet = t.side === TradeSide.BUY ? deployedNet.plus(usd) : deployedNet.minus(usd);
    if (deployedNet.gt(peakDeployed)) peakDeployed = deployedNet;

    const { hour, date, weekday } = localParts(t.blockTime, tz);
    hourly[hour].trades += 1;
    hourly[hour].realized = hourly[hour].realized.plus(realizedThis);
    const day = days.get(date) ?? { trades: 0, realized: new D(0) };
    day.trades += 1;
    day.realized = day.realized.plus(realizedThis);
    days.set(date, day);
    const cell = weekGrid[weekday][Math.floor(hour / 4)];
    cell.trades += 1;
    cell.realized = cell.realized.plus(realizedThis);

    // Trades após perda: o trade ATUAL segue imediatamente uma venda perdedora?
    if (prevWasLoss) {
      afterLossCount += 1;
      afterLossRealized = afterLossRealized.plus(realizedThis);
      if (t.side === TradeSide.SELL) {
        if (realizedThis.gt(0)) afterLossWinners += 1;
        else if (realizedThis.lt(0)) afterLossLosers += 1;
      }
    }
    prevWasLoss = t.side === TradeSide.SELL && realizedThis.lt(0);
  }

  // ── Montagem do resultado ──
  const perToken: TokenBreakdown[] = [...tokens.entries()]
    .filter(([, s]) => s.trades > 0)
    .map(([mint, s]) => ({
      mint,
      symbol: s.symbol,
      trades: s.trades,
      buyUsd: s.buyUsd.toFixed(2),
      sellUsd: s.sellUsd.toFixed(2),
      realizedPnlUsd: s.realized.toFixed(2),
      windfallUsd: s.windfall.toFixed(2),
      feesUsd: s.fees.toFixed(2),
      avgHoldSeconds: s.holdQtySum > 0 ? Math.round(s.holdWeightSum / s.holdQtySum) : null,
    }))
    .sort((a, b) => Number(b.realizedPnlUsd) - Number(a.realizedPnlUsd));

  const hourlyOut: HourBucket[] = hourly.map((h, hour) => ({
    hour,
    trades: h.trades,
    realizedPnlUsd: h.realized.toFixed(2),
  }));

  const dailyOut: DayBucket[] = [...days.entries()]
    .map(([date, d]) => ({ date, trades: d.trades, realizedPnlUsd: d.realized.toFixed(2) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const weekdayBlocks: WeekdayBlockCell[] = [];
  for (let w = 0; w < 7; w++) {
    for (let b = 0; b < 6; b++) {
      const c = weekGrid[w][b];
      weekdayBlocks.push({
        weekday: w,
        block: b,
        trades: c.trades,
        realizedPnlUsd: c.realized.toFixed(2),
        avgPnlPerTradeUsd: c.trades > 0 ? c.realized.div(c.trades).toFixed(2) : '0.00',
      });
    }
  }

  const activeDays = dailyOut.length;
  const bestDay = dailyOut.reduce<DayBucket | null>(
    (best, d) => (!best || Number(d.realizedPnlUsd) > Number(best.realizedPnlUsd) ? d : best),
    null,
  );
  const worstDay = dailyOut.reduce<DayBucket | null>(
    (worst, d) => (!worst || Number(d.realizedPnlUsd) < Number(worst.realizedPnlUsd) ? d : worst),
    null,
  );

  const entryByToken = [...tokens.entries()]
    .filter(([, s]) => s.buyCount > 0)
    .map(([mint, s]) => ({ mint, symbol: s.symbol, buyUsd: s.buyUsd.toFixed(2), buys: s.buyCount }))
    .sort((a, b) => Number(b.buyUsd) - Number(a.buyUsd));

  const totalBuyUsd = [...tokens.values()].reduce((acc, s) => acc.plus(s.buyUsd), ZERO);
  const avgBuyUsd = buys > 0 ? totalBuyUsd.div(buys) : ZERO;

  const feePct = volumeTotal.gt(0) ? Number(feesTotal.div(volumeTotal).times(100).toFixed(4)) : 0;
  const priceResolvedPct = totalTrades > 0 ? Number(((priceResolvedCount / totalTrades) * 100).toFixed(2)) : 100;
  const avgPnlPerTrade = totalTrades > 0 ? realizedTotal.div(totalTrades) : ZERO;

  // ── Win rate (posições fechadas: vendas casadas) ──
  let winners = 0;
  let losers = 0;
  for (const s of closedSells) {
    if (s.tradingPnl.gt(0)) winners += 1;
    else if (s.tradingPnl.lt(0)) losers += 1;
  }
  const decided = winners + losers;
  const winRate: WinRate = {
    closed: closedSells.length,
    winners,
    losers,
    winRatePct: decided > 0 ? Number(((winners / decided) * 100).toFixed(2)) : 0,
  };

  // ── Concentração do LUCRO BRUTO: quanto dos GANHOS vem dos melhores trades. ──
  // Denominador = soma só dos trades VENCEDORES (lucro bruto). Antes usávamos o
  // PnL LÍQUIDO (ganhos − perdas): quando o líquido é ~0 (grandes ganhos e perdas
  // se anulando), cada bucket / líquido explodia (ex.: 522%, 544%, −966%). Sobre
  // os vencedores, os buckets ficam em 0–100% e somam 100% ("100% do lucro bruto").
  // Perdas não têm "lucro" a concentrar → ficam fora deste card.
  const winningPnls = closedSells
    .map((s) => s.tradingPnl)
    .filter((v) => v.gt(0))
    .sort((a, b) => b.cmp(a));
  const grossTotal = winningPnls.reduce((acc, v) => acc.plus(v), ZERO);
  const sumRange = (from: number, to: number): Dec =>
    winningPnls.slice(from, to).reduce((acc, v) => acc.plus(v), ZERO);
  const pctOf = (v: Dec): number =>
    grossTotal.gt(0) ? Number(v.div(grossTotal).times(100).toFixed(2)) : 0;
  const concBucket = (v: Dec, count: number): ProfitConcentrationBucket => ({
    count,
    pnlUsd: v.toFixed(2),
    pct: pctOf(v),
  });
  const winnersLen = winningPnls.length;
  const profitConcentration: ProfitConcentration = {
    totalUsd: grossTotal.toFixed(2), // lucro bruto (soma dos ganhos)
    closedTrades: closedSells.length, // total de posições fechadas (contexto p/ "X de N")
    top3: concBucket(sumRange(0, 3), Math.min(3, winnersLen)),
    next7: concBucket(sumRange(3, 10), Math.max(0, Math.min(10, winnersLen) - 3)),
    rest: concBucket(sumRange(10, winnersLen), Math.max(0, winnersLen - 10)),
  };

  // ── Desfecho por múltiplo de saída (% sobre o total de posições fechadas) ──
  const closedLen = closedSells.length;
  const OUTCOME_KEYS: OutcomeKey[] = ['rugpull', 'stop_loss', 'x1_2', 'x2_5', 'x5_plus'];
  const outcomeAgg = new Map<OutcomeKey, { count: number; realized: Dec }>(
    OUTCOME_KEYS.map((k) => [k, { count: 0, realized: ZERO }]),
  );
  for (const s of closedSells) {
    const agg = outcomeAgg.get(outcomeOf(s.multiple))!;
    agg.count += 1;
    agg.realized = agg.realized.plus(s.tradingPnl);
  }
  const outcomes: OutcomeBucket[] = OUTCOME_KEYS.map((k) => {
    const agg = outcomeAgg.get(k)!;
    return {
      bucket: k,
      count: agg.count,
      pctOfClosed: closedLen > 0 ? Number(((agg.count / closedLen) * 100).toFixed(2)) : 0,
      realizedPnlUsd: agg.realized.toFixed(2),
    };
  });

  // ── Curva de capital acumulado (USD) + drawdown + dias no verde ──
  let cum = ZERO;
  let peak = ZERO;
  let maxDd = ZERO;
  let daysInGreen = 0;
  const capitalPoints = dailyOut.map((d) => {
    const realized = new D(d.realizedPnlUsd);
    if (realized.gt(0)) daysInGreen += 1;
    cum = cum.plus(realized);
    if (cum.gt(peak)) peak = cum;
    const dd = peak.minus(cum);
    if (dd.gt(maxDd)) maxDd = dd;
    return { date: d.date, cumulativePnlUsd: cum.toFixed(2) };
  });
  const windowDays = windowStart
    ? Math.max(1, Math.round((Date.now() - windowStart.getTime()) / 86_400_000))
    : dailyOut.length > 0
      ? Math.round(
          (new Date(dailyOut[dailyOut.length - 1].date).getTime() -
            new Date(dailyOut[0].date).getTime()) /
            86_400_000,
        ) + 1
      : 0;
  const capital: CapitalCurve = {
    points: capitalPoints,
    maxDrawdownUsd: maxDd.toFixed(2),
    daysInGreen,
    inactiveDays: Math.max(0, windowDays - activeDays),
  };

  // ── Bankroll: resultado e drawdown como % do pico de capital investido ──
  const bankroll: BankrollMetrics = {
    peakDeployedUsd: peakDeployed.toFixed(2),
    pnlPctOfBankroll: peakDeployed.gt(0)
      ? Number(realizedTotal.div(peakDeployed).times(100).toFixed(2))
      : null,
    maxDrawdownPct: peakDeployed.gt(0)
      ? Number(maxDd.div(peakDeployed).times(100).toFixed(2))
      : null,
  };

  return {
    method: METHOD,
    windowStart: windowStart ? windowStart.toISOString() : null,
    generatedAt: new Date().toISOString(),

    totalTrades,
    buys,
    sells,

    realizedPnlUsd: realizedTotal.toFixed(2),
    tradingPnlUsd: tradingTotal.toFixed(2),
    windfallProceedsUsd: windfallTotal.toFixed(2),
    feesUsd: feesTotal.toFixed(2),
    netPnlUsd: tradingTotal.minus(feesTotal).toFixed(2), // líquido de TRADING (exclui windfall)
    volumeUsd: volumeTotal.toFixed(2),
    feePctOfVolume: feePct,

    avgHoldSecondsWinners: holdWinQty > 0 ? Math.round(holdWinWeight / holdWinQty) : null,
    avgHoldSecondsLosers: holdLossQty > 0 ? Math.round(holdLossWeight / holdLossQty) : null,

    entrySizes: {
      totalBuyUsd: totalBuyUsd.toFixed(2),
      avgBuyUsd: avgBuyUsd.toFixed(2),
      byToken: entryByToken,
    },

    perDay: {
      activeDays,
      avgTradesPerActiveDay: activeDays > 0 ? Number((totalTrades / activeDays).toFixed(2)) : 0,
      avgPnlPerTrade: avgPnlPerTrade.toFixed(2),
      bestDay,
      worstDay,
    },

    hourly: hourlyOut,
    daily: dailyOut,
    weekdayBlocks,
    tradesAfterLoss: {
      count: afterLossCount,
      winners: afterLossWinners,
      losers: afterLossLosers,
      realizedPnlUsd: afterLossRealized.toFixed(2),
    },
    perToken,
    winRate,
    profitConcentration,
    outcomes,
    capital,
    bankroll,
    confidence: {
      priceResolvedPct,
      unmatchedSellCount,
      note:
        unmatchedSellCount > 0
          ? 'Algumas vendas são de tokens sem compra no histórico (airdrop/mint/transfer). ' +
            'Seus proceeds NÃO entram no PnL de trading — vão em windfallProceedsUsd. ' +
            'tradingPnlUsd reflete só as vendas casadas com compras reais.'
          : 'Todas as vendas foram casadas contra compras conhecidas.',
    },
  };
}

/**
 * Extrai as POSIÇÕES FECHADAS (vendas casadas FIFO) com entrada/saída, insumo do
 * engine de pico (Bloco 2). Reexecuta um casamento FIFO enxuto — só o necessário —
 * para manter `computePnl` intacto (menor risco de regressão nas métricas do Bloco 1).
 */
export function computeClosedPositions(
  trades: TradeInput[],
  opts: PnlOptions,
): ClosedPosition[] {
  const windowStart = opts.windowStart;
  const inWindow = (t: TradeInput) => !windowStart || t.blockTime >= windowStart;
  const sorted = [...trades].sort((a, b) => a.blockTime.getTime() - b.blockTime.getTime());

  const lotsByMint = new Map<string, { qty: Dec; unitCost: Dec; timeMs: number }[]>();
  const symbolByMint = new Map<string, string | null>();
  const positions: ClosedPosition[] = [];

  for (const t of sorted) {
    if (t.baseSymbol && !symbolByMint.get(t.baseMint)) {
      symbolByMint.set(t.baseMint, t.baseSymbol);
    }
    const qty = new D(t.baseAmount || '0');
    const price = new D(t.priceUsd || '0');
    let lots = lotsByMint.get(t.baseMint);
    if (!lots) {
      lots = [];
      lotsByMint.set(t.baseMint, lots);
    }

    if (t.side === TradeSide.BUY) {
      lots.push({ qty, unitCost: price, timeMs: t.blockTime.getTime() });
      continue;
    }

    // SELL: casa FIFO; a posição fechada guarda o hold [entrada mais antiga → venda].
    let remaining = qty;
    let matchedQty = ZERO;
    let costBasis = ZERO;
    let earliestEntryMs = t.blockTime.getTime();
    while (remaining.gt(0) && lots.length > 0) {
      const lot = lots[0];
      const take = Prisma.Decimal.min(remaining, lot.qty);
      matchedQty = matchedQty.plus(take);
      costBasis = costBasis.plus(lot.unitCost.times(take));
      earliestEntryMs = Math.min(earliestEntryMs, lot.timeMs);
      lot.qty = lot.qty.minus(take);
      remaining = remaining.minus(take);
      if (lot.qty.lte(0)) lots.shift();
    }

    if (!inWindow(t) || matchedQty.lte(0)) continue;
    const qtyNum = Number(matchedQty.toString());
    const entryPrice = Number(costBasis.div(matchedQty).toString());
    const exitPrice = Number(price.toString());
    positions.push({
      mint: t.baseMint,
      symbol: symbolByMint.get(t.baseMint) ?? t.baseSymbol ?? null,
      entryTimeMs: earliestEntryMs,
      exitTimeMs: t.blockTime.getTime(),
      entryPriceUsd: entryPrice,
      exitPriceUsd: exitPrice,
      qty: qtyNum,
      tradingPnlUsd: (exitPrice - entryPrice) * qtyNum,
    });
  }

  return positions;
}
