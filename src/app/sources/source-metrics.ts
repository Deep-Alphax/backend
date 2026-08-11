import { Prisma, TradeSide } from '@prisma/client';
import {
  ClosedPosition,
  CandlePoint,
} from '../analytics/profile-metrics.types';
import { computePeakMetrics } from '../analytics/peak-engine';

/**
 * Agregação de métricas POR FONTE (puro, testável). Reexecuta um casamento FIFO
 * enxuto sobre os trades do usuário, atribuindo cada FATIA realizada (venda casada
 * contra um lote de compra) à(s) fonte(s) daquela compra. Assim uma venda que
 * consome lotes de compras de fontes diferentes divide o PnL entre elas — sem
 * colapsar a origem. Dinheiro em Decimal (precisão), multiplicadores em number.
 */

const D = Prisma.Decimal;
type Dec = Prisma.Decimal;
const ZERO = new D(0);

export type RecommendationKey =
  | 'usar_mais'
  | 'manter'
  | 'reduzir_size'
  | 'revisar_entrada'
  | 'observar'
  | 'cortar'
  | 'aposta_curta';

/** Linha da tab "De onde vieram os trades" (contrato com o frontend). */
export interface SourceBreakdown {
  id: string;
  name: string;
  trades: number; // posições fechadas (fatias realizadas) atribuídas à fonte
  winRatePct: number;
  medianExitMultiple: number | null; // mediana do múltiplo de saída (puro FIFO)
  capture: { pct: number; onTarget: boolean } | null; // Bloco 2 (candles); null sem cobertura
  pnlUsd: string;
  recommendation: RecommendationKey;
}

/** Trade do usuário (projeção mínima) para o motor de fonte. */
export interface SourceTradeInput {
  id: string;
  mint: string;
  symbol: string | null;
  side: TradeSide;
  blockTimeMs: number;
  baseAmount: string; // decimal string
  priceUsd: string; // USD por 1 base
}

export interface SourceMeta {
  id: string;
  name: string;
}

export interface SourceMetricsOptions {
  /** Início da janela (inclusive) — só emite fatias cuja VENDA cai na janela. null = tudo. */
  windowStart: Date | null;
}

// ── Limiares da heurística de recomendação (produto — ajustáveis) ──
const MIN_SAMPLE = 5; // abaixo disto a amostra é pequena demais para recomendar
const CUT_WINRATE = 35; // perde dinheiro E erra muito → cortar
const OK_WINRATE = 45; // acerto "aceitável"
const STRONG_WINRATE = 60; // acerto forte
const LOW_CAPTURE = 35; // aproveita pouco do topo (entra/sai mal)
const GOOD_CAPTURE = 50; // segura o alvo

/**
 * Heurística de recomendação (7 chaves). Ordem de decisão pensada para as 3
 * prioridades do produto: primeiro corta o que destrói capital, depois promove o
 * que compõe, e sinaliza ajuste fino no meio. Amostra pequena → apenas observar.
 */
export function recommend(m: {
  trades: number;
  winRatePct: number;
  pnlNum: number;
  medianExitMultiple: number | null;
  capturePct: number | null;
}): RecommendationKey {
  if (m.trades < MIN_SAMPLE) return 'observar';

  if (m.pnlNum < 0) {
    return m.winRatePct < CUT_WINRATE ? 'cortar' : 'reduzir_size';
  }

  // PnL ≥ 0
  if (m.capturePct != null && m.capturePct < LOW_CAPTURE)
    return 'revisar_entrada';
  if (
    m.winRatePct >= STRONG_WINRATE &&
    (m.capturePct == null || m.capturePct >= GOOD_CAPTURE)
  ) {
    return 'usar_mais';
  }
  if (m.winRatePct >= OK_WINRATE) return 'manter';
  // Positivo, mas com baixo acerto: lucro carregado por poucos acertos.
  if (m.medianExitMultiple != null && m.medianExitMultiple < 1)
    return 'revisar_entrada';
  return 'aposta_curta';
}

/** Mediana de uma lista de números (assume não-vazia). */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

interface Lot {
  qty: Dec;
  unitCost: Dec;
  timeMs: number;
  buyTradeId: string;
}

interface SourceAcc {
  positions: ClosedPosition[]; // p/ capture (Bloco 2)
  pnl: Dec;
  winners: number;
  losers: number;
  multiples: number[]; // múltiplos de saída finitos (p/ mediana)
}

function newAcc(): SourceAcc {
  return { positions: [], pnl: ZERO, winners: 0, losers: 0, multiples: [] };
}

/**
 * Calcula o breakdown por fonte. `attributionByBuyTradeId` mapeia a COMPRA do
 * usuário → fontes atribuídas (lead-lag). `candlesByMint` é opcional: presente →
 * capture (aproveitamento do topo) por fonte; ausente → capture null ("—").
 * Todas as fontes de `sources` entram no resultado (zeradas quando sem trades).
 */
export function computeSourceBreakdown(
  userTrades: SourceTradeInput[],
  attributionByBuyTradeId: Map<string, string[]>,
  sources: SourceMeta[],
  opts: SourceMetricsOptions,
  candlesByMint?: Map<string, CandlePoint[]>,
): SourceBreakdown[] {
  const windowStart = opts.windowStart;
  const inWindow = (timeMs: number) =>
    !windowStart || timeMs >= windowStart.getTime();

  const sorted = [...userTrades].sort((a, b) => a.blockTimeMs - b.blockTimeMs);
  const lotsByMint = new Map<string, Lot[]>();
  const symbolByMint = new Map<string, string | null>();
  const acc = new Map<string, SourceAcc>();
  for (const s of sources) acc.set(s.id, newAcc());

  for (const t of sorted) {
    if (t.symbol && !symbolByMint.get(t.mint))
      symbolByMint.set(t.mint, t.symbol);
    const qty = new D(t.baseAmount || '0');
    const price = new D(t.priceUsd || '0');
    let lots = lotsByMint.get(t.mint);
    if (!lots) {
      lots = [];
      lotsByMint.set(t.mint, lots);
    }

    if (t.side === TradeSide.BUY) {
      lots.push({
        qty,
        unitCost: price,
        timeMs: t.blockTimeMs,
        buyTradeId: t.id,
      });
      continue;
    }

    // SELL: casa FIFO. Cada lote consumido vira uma fatia atribuída à(s) fonte(s)
    // da COMPRA daquele lote. Só conta quando a venda cai na janela.
    const emit = inWindow(t.blockTimeMs);
    let remaining = qty;
    while (remaining.gt(0) && lots.length > 0) {
      const lot = lots[0];
      const take = Prisma.Decimal.min(remaining, lot.qty);
      lot.qty = lot.qty.minus(take);
      remaining = remaining.minus(take);
      if (lot.qty.lte(0)) lots.shift();

      if (!emit) continue;
      const sourceIds = attributionByBuyTradeId.get(lot.buyTradeId);
      if (!sourceIds || sourceIds.length === 0) continue;

      const takeNum = Number(take.toString());
      const entryPrice = Number(lot.unitCost.toString());
      const exitPrice = Number(price.toString());
      const pnl = price.minus(lot.unitCost).times(take);
      const pnlNum = (exitPrice - entryPrice) * takeNum;
      // Múltiplo de saída = preço de venda ÷ custo do lote. Sem custo (lote a 0):
      // não-finito → fora da mediana (mesma convenção do motor de pico).
      const multiple = entryPrice > 0 ? exitPrice / entryPrice : NaN;

      for (const sourceId of sourceIds) {
        const a = acc.get(sourceId);
        if (!a) continue; // fonte não listada (inativa) — ignora
        a.pnl = a.pnl.plus(pnl);
        if (pnl.gt(0)) a.winners += 1;
        else if (pnl.lt(0)) a.losers += 1;
        if (Number.isFinite(multiple)) a.multiples.push(multiple);
        a.positions.push({
          mint: t.mint,
          symbol: symbolByMint.get(t.mint) ?? t.symbol ?? null,
          entryTimeMs: lot.timeMs,
          exitTimeMs: t.blockTimeMs,
          entryPriceUsd: entryPrice,
          exitPriceUsd: exitPrice,
          qty: takeNum,
          tradingPnlUsd: pnlNum,
        });
      }
    }
  }

  const rows: SourceBreakdown[] = sources.map((s) => {
    const a = acc.get(s.id) as SourceAcc;
    const trades = a.positions.length;
    const decided = a.winners + a.losers;
    const winRatePct =
      decided > 0 ? Number(((a.winners / decided) * 100).toFixed(2)) : 0;
    const medianExitMultiple =
      a.multiples.length > 0 ? Number(median(a.multiples).toFixed(2)) : null;

    // Capture (Bloco 2): só quando há candles. topCapturePct agregado da fonte.
    let capture: { pct: number; onTarget: boolean } | null = null;
    if (candlesByMint && trades > 0) {
      const peak = computePeakMetrics(a.positions, candlesByMint);
      if (peak.available && peak.topCapturePct != null) {
        capture = {
          pct: peak.topCapturePct,
          onTarget: peak.topCapturePct >= GOOD_CAPTURE,
        };
      }
    }

    const pnlNum = Number(a.pnl.toString());
    return {
      id: s.id,
      name: s.name,
      trades,
      winRatePct,
      medianExitMultiple,
      capture,
      pnlUsd: a.pnl.toFixed(2),
      recommendation: recommend({
        trades,
        winRatePct,
        pnlNum,
        medianExitMultiple,
        capturePct: capture?.pct ?? null,
      }),
    };
  });

  // Mais relevantes primeiro: mais trades, depois maior PnL.
  return rows.sort(
    (a, b) => b.trades - a.trades || Number(b.pnlUsd) - Number(a.pnlUsd),
  );
}
