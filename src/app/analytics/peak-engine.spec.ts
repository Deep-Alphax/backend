import {
  computePeakMetrics,
  buildBenchmark,
  computeSolBenchmark,
  computeSurvival,
  type SolTradeInput,
} from './peak-engine';
import { ClosedPosition, CandlePoint } from './profile-metrics.types';

const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function trade(over: Partial<SolTradeInput>): SolTradeInput {
  return {
    side: 'BUY',
    blockTimeMs: 0,
    baseMint: 'TKN',
    baseAmount: '10',
    quoteMint: WSOL,
    quoteAmount: '1',
    ...over,
  };
}

const DAY = 24 * 60 * 60 * 1000;

function pos(over: Partial<ClosedPosition>): ClosedPosition {
  return {
    mint: 'A',
    symbol: 'A',
    entryTimeMs: 0,
    exitTimeMs: 100,
    entryPriceUsd: 1,
    exitPriceUsd: 2,
    qty: 10,
    tradingPnlUsd: 10,
    ...over,
  };
}

describe('computePeakMetrics', () => {
  it('sem posições → indisponível', () => {
    const r = computePeakMetrics([], new Map());
    expect(r.available).toBe(false);
    expect(r.topCapturePct).toBeNull();
    expect(r.coveragePct).toBe(0);
  });

  it('captura = (saída−entrada)/(pico−entrada); agrega ponderado por qty', () => {
    const positions = [
      // Subiu 4x (pico) e capturou 2/3 (saída 3x): NÃO devolveu.
      pos({
        mint: 'A',
        entryPriceUsd: 1,
        exitPriceUsd: 3,
        qty: 10,
        exitTimeMs: 100,
      }),
      // Subiu 3x e capturou só 10% (saída 1,2x): devolveu.
      pos({
        mint: 'B',
        symbol: 'B',
        entryPriceUsd: 1,
        exitPriceUsd: 1.2,
        qty: 5,
        exitTimeMs: 200,
      }),
    ];
    const candles = new Map<string, CandlePoint[]>([
      ['A', [{ timeMs: 50, high: 4 }]],
      ['B', [{ timeMs: 50, high: 3 }]],
    ]);
    const r = computePeakMetrics(positions, candles);

    expect(r.available).toBe(true);
    expect(r.coveragePct).toBe(100);
    // Num = (3-1)*10 + (1.2-1)*5 = 21 ; Den = (4-1)*10 + (3-1)*5 = 40 → 52,5%
    expect(r.topCapturePct).toBeCloseTo(52.5, 1);
    expect(r.gaveBackCount).toBe(1);
    // perTrade ordenado por saída desc → B (exit 200) primeiro.
    expect(r.perTrade[0].mint).toBe('B');
    expect(r.perTrade[0].peakMultiple).toBeCloseTo(3, 5);
    const a = r.perTrade.find((p) => p.mint === 'A')!;
    expect(a.capturePct).toBeCloseTo(66.67, 1);
  });

  it('posição sem candle não entra na captura e reduz a cobertura', () => {
    const positions = [
      pos({ mint: 'A', exitTimeMs: 100 }),
      pos({ mint: 'NODATA', symbol: 'X', exitTimeMs: 200 }),
    ];
    const candles = new Map<string, CandlePoint[]>([
      ['A', [{ timeMs: 50, high: 4 }]],
    ]);
    const r = computePeakMetrics(positions, candles);
    expect(r.coveragePct).toBe(50);
    const nodata = r.perTrade.find((p) => p.mint === 'NODATA')!;
    expect(nodata.hasData).toBe(false);
  });
});

describe('buildBenchmark', () => {
  it('converte capital acumulado USD em SOL por dia; omite dias sem preço', () => {
    const points = [
      { date: '2026-07-01', cumulativePnlUsd: '100' },
      { date: '2026-07-02', cumulativePnlUsd: '200' },
      { date: '2026-07-03', cumulativePnlUsd: '300' }, // sem preço → omitido
    ];
    const sol = new Map<string, number>([
      ['2026-07-01', 100],
      ['2026-07-02', 200],
    ]);
    const r = buildBenchmark(points, sol);
    expect(r.available).toBe(true);
    expect(r.points).toHaveLength(2);
    expect(r.points[0].portfolioInSol).toBe('1.0000');
  });
});

describe('computeSolBenchmark', () => {
  const noWindow = { windowStart: null, tzOffsetMinutes: 0 };

  it('round-trip casado WSOL = proceeds − custo (compra por 2, vende por 5 → +3)', () => {
    // Compra 10 tokens por 2 SOL; vende os 10 por 5 SOL → PnL realizado +3 SOL.
    const trades = [
      trade({
        side: 'BUY',
        baseAmount: '10',
        quoteAmount: '2',
        blockTimeMs: 0,
      }),
      trade({
        side: 'SELL',
        baseAmount: '10',
        quoteAmount: '5',
        blockTimeMs: DAY,
      }),
    ];
    const r = computeSolBenchmark(trades, new Map(), noWindow);
    expect(r.available).toBe(true);
    // Só a venda gera ponto (a compra é deploy neutro, não vira ponto negativo).
    expect(r.points).toHaveLength(1);
    expect(r.points[0].portfolioInSol).toBe('3.0000');
  });

  it('deploy de capital NÃO vira prejuízo: a curva não mergulha no negativo no 1º dia', () => {
    // Regressão do bug: compra 10 tokens por 30 SOL no dia 1, vende por 33 no dia 2.
    // A linha antiga (fluxo de caixa) despencava p/ −30 no dia 1. Agora começa em +3.
    const trades = [
      trade({
        side: 'BUY',
        baseAmount: '10',
        quoteAmount: '30',
        blockTimeMs: 0,
      }),
      trade({
        side: 'SELL',
        baseAmount: '10',
        quoteAmount: '33',
        blockTimeMs: DAY,
      }),
    ];
    const r = computeSolBenchmark(trades, new Map(), noWindow);
    const vals = r.points.map((p) => Number(p.portfolioInSol));
    expect(Math.min(...vals)).toBeGreaterThanOrEqual(0); // nunca negativa por deploy
    expect(r.points[r.points.length - 1].portfolioInSol).toBe('3.0000');
  });

  it('venda sem lote (posição pré-DADOS) CONTA como proceeds cheio (custo 0)', () => {
    // Sem compra sincronizada anterior → não há lote → windfall: proceeds cheio.
    const trades = [
      trade({
        side: 'SELL',
        baseAmount: '10',
        quoteAmount: '9',
        blockTimeMs: 0,
      }),
    ];
    const r = computeSolBenchmark(trades, new Map(), noWindow);
    expect(r.available).toBe(true);
    expect(r.points[r.points.length - 1].portfolioInSol).toBe('9.0000');
  });

  it('curva acumula por dia; só perda REAL de SOL num round-trip desce a curva', () => {
    // Compra 10@30 (dia1, neutro). Vende 5@10 dia2: custo casado 15 → −5 (perda real).
    // Vende 5@40 dia3: custo casado 15 → +25. Cum: 0(implícito) → −5 → +20.
    const trades = [
      trade({
        side: 'BUY',
        baseAmount: '10',
        quoteAmount: '30',
        blockTimeMs: 0,
      }),
      trade({
        side: 'SELL',
        baseAmount: '5',
        quoteAmount: '10',
        blockTimeMs: DAY,
      }),
      trade({
        side: 'SELL',
        baseAmount: '5',
        quoteAmount: '40',
        blockTimeMs: 2 * DAY,
      }),
    ];
    const r = computeSolBenchmark(trades, new Map(), noWindow);
    expect(r.points.map((p) => p.portfolioInSol)).toEqual([
      '-5.0000',
      '20.0000',
    ]);
  });

  it('perna em stablecoin: custo e proceeds convertidos ao preço do SOL do dia', () => {
    // Compra 10 tokens por 200 USDC; vende por 500 USDC. SOL=100 USD nos dois dias.
    // → custo 2 SOL, proceeds 5 SOL, realizado +3 SOL.
    const trades = [
      trade({
        side: 'BUY',
        baseAmount: '10',
        quoteMint: USDC,
        quoteAmount: '200',
        blockTimeMs: 0,
      }),
      trade({
        side: 'SELL',
        baseAmount: '10',
        quoteMint: USDC,
        quoteAmount: '500',
        blockTimeMs: DAY,
      }),
    ];
    const sol = new Map<string, number>([
      ['1970-01-01', 100],
      ['1970-01-02', 100],
    ]);
    const r = computeSolBenchmark(trades, sol, noWindow);
    expect(Number(r.points[r.points.length - 1].portfolioInSol)).toBeCloseTo(
      3,
      4,
    );
  });

  it('janela: compra pré-janela dá base de custo; só a venda na janela realiza', () => {
    // Compra 10@2 fora da janela (base de custo preservada) e vende 10@5 dentro.
    // Realizado no período = proceeds 5 − custo 2 = +3 (não +5).
    const trades = [
      trade({
        side: 'BUY',
        baseAmount: '10',
        quoteAmount: '2',
        blockTimeMs: 0,
      }),
      trade({
        side: 'SELL',
        baseAmount: '10',
        quoteAmount: '5',
        blockTimeMs: 10 * DAY,
      }),
    ];
    const r = computeSolBenchmark(trades, new Map(), {
      windowStart: new Date(5 * DAY),
      tzOffsetMinutes: 0,
    });
    expect(r.points).toHaveLength(1);
    expect(r.points[0].portfolioInSol).toBe('3.0000');
  });

  it('quote desconhecida é ignorada por completo (não realiza perda espúria)', () => {
    // Nem empilha lote na compra, nem realiza na venda → sem pontos.
    const trades = [
      trade({
        side: 'BUY',
        quoteMint: 'XyZ',
        baseAmount: '10',
        quoteAmount: '5',
        blockTimeMs: 0,
      }),
      trade({
        side: 'SELL',
        quoteMint: 'XyZ',
        baseAmount: '10',
        quoteAmount: '9',
        blockTimeMs: DAY,
      }),
    ];
    const r = computeSolBenchmark(trades, new Map(), noWindow);
    expect(r.available).toBe(false);
    expect(r.points).toHaveLength(0);
  });

  it('FIFO por token: lotes não cruzam entre mints diferentes', () => {
    // Compra AAA@3 e BBB@10; vende AAA@5 → só casa contra AAA (custo 3) = +2.
    const trades = [
      trade({
        side: 'BUY',
        baseMint: 'AAA',
        baseAmount: '10',
        quoteAmount: '3',
        blockTimeMs: 0,
      }),
      trade({
        side: 'BUY',
        baseMint: 'BBB',
        baseAmount: '10',
        quoteAmount: '10',
        blockTimeMs: 0,
      }),
      trade({
        side: 'SELL',
        baseMint: 'AAA',
        baseAmount: '10',
        quoteAmount: '5',
        blockTimeMs: DAY,
      }),
    ];
    const r = computeSolBenchmark(trades, new Map(), noWindow);
    expect(r.points[r.points.length - 1].portfolioInSol).toBe('2.0000');
  });
});

describe('computeSurvival', () => {
  it('taxa de sobrevida sobre tokens de status conhecido', () => {
    const r = computeSurvival(['alive', 'alive', 'dead', 'unknown']);
    expect(r.alive).toBe(2);
    expect(r.dead).toBe(1);
    expect(r.unknown).toBe(1);
    expect(r.alivePct).toBeCloseTo(66.67, 1); // 2 / (2+1)
  });
});
