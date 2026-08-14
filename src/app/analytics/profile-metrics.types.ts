import { PnlResult } from './pnl-types';

/**
 * Tipos das métricas de perfil que dependem de HISTÓRICO DE PREÇO (Bloco 2).
 * Computadas no serviço (com candles do provider), não no `computePnl` puro.
 */

/** Posição fechada (venda casada FIFO) com entrada/saída — base do cálculo de pico. */
export interface ClosedPosition {
  mint: string;
  symbol: string | null;
  entryTimeMs: number; // lote casado mais antigo (início do hold)
  exitTimeMs: number; // instante da venda
  entryPriceUsd: number; // custo médio dos lotes casados
  exitPriceUsd: number; // preço da venda
  qty: number; // quantidade casada
  tradingPnlUsd: number; // PnL de trading da posição
}

/** Posição AINDA EM CARTEIRA (lotes FIFO não vendidos) — base do PnL não-realizado. */
export interface OpenPosition {
  mint: string;
  symbol: string | null;
  qty: string; // quantidade remanescente
  costUsd: string; // base de custo (USD) da quantidade remanescente
}

/** Vela OHLC mínima que o engine de pico consome (primitivos, sem acoplar provider). */
export interface CandlePoint {
  timeMs: number; // início do bucket (UTC)
  high: number; // maior preço USD no bucket
}

/** Uma coluna do gráfico "topo × saída". */
export interface PerTradePeak {
  mint: string;
  symbol: string | null;
  exitTime: string; // ISO
  peakMultiple: number; // pico ÷ entrada
  exitMultiple: number; // saída ÷ entrada
  capturePct: number; // (saída−entrada) ÷ (pico−entrada) · 100
  tradingPnlUsd: string;
  hasData: boolean; // false quando faltou candle p/ a posição
}

export interface PeakMetrics {
  available: boolean; // houve dado de pico p/ ao menos 1 posição
  coveragePct: number; // % das posições fechadas com candles
  topCapturePct: number | null; // aproveitamento do topo agregado
  gaveBackCount: number; // posições que subiram e devolveram o ganho
  perTrade: PerTradePeak[]; // posições mais recentes (p/ o gráfico)
}

export interface BenchmarkPoint {
  date: string; // YYYY-MM-DD
  portfolioInSol: string; // capital acumulado medido em SOL
}

export interface Benchmark {
  available: boolean;
  points: BenchmarkPoint[];
}

export interface Survival {
  available: boolean;
  alivePct: number | null; // % de tokens ainda vivos
  alive: number;
  dead: number;
  unknown: number;
}

/**
 * PnL NÃO-REALIZADO: valor atual das posições ainda em carteira (posições abertas)
 * menos a base de custo delas. Precisa de preço atual (Bloco 2, best-effort). Token
 * sem preço (sem par/rugado) conta como valor 0 → perda de 100% do custo.
 */
export interface Unrealized {
  available: boolean; // houve preço p/ estimar (senão null)
  unrealizedPnlUsd: string | null; // valor atual − custo das posições abertas
  openPositions: number; // nº de tokens ainda em carteira
  pricedPositions: number; // quantos deles tiveram preço resolvido
}

/** Resposta completa do endpoint de perfil: Bloco 1 (PnlResult) + Bloco 2. */
export interface ProfileMetrics extends PnlResult {
  peaks: PeakMetrics;
  survival: Survival;
  benchmark: Benchmark;
  unrealized: Unrealized;
}
