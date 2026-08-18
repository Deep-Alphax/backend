import { TradeSide } from '@prisma/client';

/** Trade de entrada do motor (projeção mínima do modelo Prisma `Trade`). */
export interface TradeInput {
  blockTime: Date; // UTC
  side: TradeSide;
  baseMint: string;
  baseSymbol: string | null;
  baseAmount: string; // decimal string
  usdValue: string; // notional USD
  priceUsd: string; // USD por 1 base
  feeUsd: string; // taxa em USD
  priceResolved: boolean;
}

export interface PnlOptions {
  /** Início da janela (inclusive). null = desde sempre. */
  windowStart: Date | null;
  /** Offset do fuso do usuário em minutos p/ o bucket "hora do dia" (ex.: BRT = -180). Default 0 (UTC). */
  tzOffsetMinutes?: number;
}

export interface HourBucket {
  hour: number; // 0..23 (no fuso do usuário)
  trades: number;
  realizedPnlUsd: string;
}

export interface DayBucket {
  date: string; // YYYY-MM-DD (no fuso do usuário)
  trades: number;
  realizedPnlUsd: string;
}

/**
 * Célula do heatmap "dia da semana × bloco do dia" (tab "Quando e onde").
 * `weekday`: 0=Seg … 6=Dom. `block`: 0..5 (00–04h, 04–08h, …, 20–24h), no fuso do usuário.
 */
export interface WeekdayBlockCell {
  weekday: number;
  block: number;
  trades: number;
  realizedPnlUsd: string;
  avgPnlPerTradeUsd: string;
}

export interface TokenBreakdown {
  mint: string;
  symbol: string | null;
  trades: number;
  buyUsd: string; // total investido (entradas)
  sellUsd: string; // total desinvestido
  realizedPnlUsd: string; // bruto = trading + windfall
  windfallUsd: string; // parte vinda de vendas sem base de custo (airdrop/mint/transfer)
  feesUsd: string;
  avgHoldSeconds: number | null; // null se nenhuma venda casada
}

export interface TradesAfterLoss {
  /** Trades que ocorreram imediatamente após uma venda com prejuízo (sinal de revenge trading). */
  count: number;
  winners: number; // dentre os que foram vendas, quantas lucraram
  losers: number;
  realizedPnlUsd: string; // PnL agregado desses trades pós-perda
}

export interface Confidence {
  /** % de trades da janela com preço USD resolvido pelo provider (não estimado). */
  priceResolvedPct: number;
  /** Vendas sem lote de compra correspondente (base de custo desconhecida → tratada como 0). */
  unmatchedSellCount: number;
  note: string;
}

/**
 * Taxa de acerto sobre POSIÇÕES FECHADAS (vendas casadas com lotes reais).
 * `winRatePct` = winners / (winners + losers) — break-even não entra no denominador.
 */
export interface WinRate {
  closed: number; // vendas casadas consideradas (inclui break-even)
  winners: number; // PnL de trading > 0
  losers: number; // PnL de trading < 0
  winRatePct: number;
}

/**
 * Concentração do lucro: quanto do PnL de trading vem dos poucos melhores trades.
 * Buckets por ranking de PnL (desc): top 3, 4–10 e o resto. `pct` é a fatia do
 * total (Σ de todas as vendas casadas = tradingPnl). Só faz sentido com total > 0.
 */
export interface ProfitConcentrationBucket {
  count: number;
  pnlUsd: string;
  pct: number; // % do total (0 se total ≤ 0)
}

export interface ProfitConcentration {
  totalUsd: string; // Σ PnL de trading das vendas casadas (base dos %)
  closedTrades: number;
  top3: ProfitConcentrationBucket;
  next7: ProfitConcentrationBucket; // ranks 4–10
  rest: ProfitConcentrationBucket;
}

/**
 * Desfecho por TOKEN (agregado, não por venda — igual à Axiom) classificado pelo
 * MÚLTIPLO realizado = proceeds ÷ base de custo casada (= 1 + PnL/custo). Um token
 * conta UMA vez (soma de todas as vendas casadas no período). Só posições
 * TOTALMENTE FECHADAS entram (sem lotes de compra restantes no FIFO) — um token que
 * você vendeu só em parte e ainda segura não "terminou". Tokens sem base de custo
 * (só windfall/airdrop) ficam de fora. rugpull/stop_loss são heurísticos por
 * severidade da perda (não há detecção on-chain de rug aqui):
 *   rugpull  multiple < 0.1  (perdeu ≥ 90%)
 *   stop_loss 0.1 ≤ m < 1
 *   x1_2      1 ≤ m < 2
 *   x2_5      2 ≤ m < 5
 *   x5_plus   m ≥ 5
 */
export type OutcomeKey = 'rugpull' | 'stop_loss' | 'x1_2' | 'x2_5' | 'x5_plus';

export interface OutcomeBucket {
  bucket: OutcomeKey;
  count: number;
  pctOfClosed: number;
  realizedPnlUsd: string; // PnL de trading agregado do bucket
}

/**
 * Curva de capital acumulado (Σ do PnL realizado por dia) e derivados. USD only —
 * a série "medida em SOL"/benchmark exige preço histórico (Bloco 2, não incluído).
 */
export interface CapitalPoint {
  date: string; // YYYY-MM-DD
  cumulativePnlUsd: string;
}

export interface CapitalCurve {
  points: CapitalPoint[];
  maxDrawdownUsd: string; // maior queda pico→vale do acumulado (≥ 0)
  daysInGreen: number; // dias com PnL realizado > 0
  inactiveDays: number; // dias da janela sem operar
}

/**
 * Bankroll = pico do capital LÍQUIDO investido (running Σ compras − vendas).
 * Base para expressar resultado e drawdown em % (o que o dashboard mostra como
 * "+X% sobre o bankroll" e "drawdown −Y%"). Puro: derivado só dos cashflows.
 */
export interface BankrollMetrics {
  peakDeployedUsd: string; // maior capital líquido em risco no período
  pnlPctOfBankroll: number | null; // realizado ÷ bankroll (null se bankroll ≤ 0)
  maxDrawdownPct: number | null; // maior drawdown ÷ bankroll (null se bankroll ≤ 0)
}

/** Resultado completo das métricas de uma janela. Money como string (JSON-safe). */
export interface PnlResult {
  method: string;
  windowStart: string | null;
  generatedAt: string;

  totalTrades: number;
  buys: number;
  sells: number;

  // realizedPnlUsd (bruto) = tradingPnlUsd + windfallProceedsUsd.
  //  - tradingPnlUsd: PnL de vendas CASADAS com compras reais (habilidade de trading).
  //  - windfallProceedsUsd: proceeds de vendas SEM base de custo (tokens recebidos por
  //    airdrop/mint/transfer — não é lucro de trading, é entrada "de graça"). Inflaria
  //    o número se somado como skill; por isso é reportado à parte.
  realizedPnlUsd: string;
  tradingPnlUsd: string;
  windfallProceedsUsd: string;
  feesUsd: string;
  netPnlUsd: string; // tradingPnl - fees (PnL líquido de trading)
  volumeUsd: string;
  feePctOfVolume: number;

  avgHoldSecondsWinners: number | null;
  avgHoldSecondsLosers: number | null;

  entrySizes: {
    totalBuyUsd: string;
    avgBuyUsd: string;
    byToken: { mint: string; symbol: string | null; buyUsd: string; buys: number }[];
  };

  perDay: {
    activeDays: number;
    avgTradesPerActiveDay: number;
    avgPnlPerTrade: string;
    bestDay: DayBucket | null;
    worstDay: DayBucket | null;
  };

  hourly: HourBucket[]; // sempre 24 posições
  daily: DayBucket[];
  weekdayBlocks: WeekdayBlockCell[]; // sempre 42 posições (7 dias × 6 blocos)
  tradesAfterLoss: TradesAfterLoss;
  perToken: TokenBreakdown[];
  confidence: Confidence;

  // ── Métricas de perfil (dashboard) ──
  winRate: WinRate;
  profitConcentration: ProfitConcentration;
  outcomes: OutcomeBucket[]; // sempre as 5 chaves, na ordem rugpull→x5_plus
  capital: CapitalCurve;
  bankroll: BankrollMetrics;
}
