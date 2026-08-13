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

  it('fluxo líquido WSOL = SOL recebido nas vendas − SOL gasto nas compras', () => {
    // Gasta 2 SOL comprando; recebe 5 SOL vendendo → fluxo líquido +3 SOL.
    const trades = [
      trade({ side: 'BUY', quoteAmount: '2', blockTimeMs: 0 }),
      trade({ side: 'SELL', quoteAmount: '5', blockTimeMs: DAY }),
    ];
    const r = computeSolBenchmark(trades, new Map(), noWindow);
    expect(r.available).toBe(true);
    expect(r.points[r.points.length - 1].portfolioInSol).toBe('3.0000');
  });

  it('venda sem compra anterior (posição pré-dados) CONTA como SOL recebido', () => {
    // Vital p/ histórico incompleto: a venda de um bag comprado antes do 1º trade
    // sincronizado é SOL real que entrou — o fluxo líquido não pode descartá-la.
    const trades = [trade({ side: 'SELL', quoteAmount: '9', blockTimeMs: 0 })];
    const r = computeSolBenchmark(trades, new Map(), noWindow);
    expect(r.available).toBe(true);
    expect(r.points[r.points.length - 1].portfolioInSol).toBe('9.0000');
  });

  it('curva acumula por dia (compra abaixa, venda sobe)', () => {
    const trades = [
      trade({ side: 'BUY', quoteAmount: '2', blockTimeMs: 0 }), // dia 1: −2
      trade({ side: 'SELL', quoteAmount: '3', blockTimeMs: DAY }), // dia 2: +3 → +1
      trade({ side: 'SELL', quoteAmount: '4', blockTimeMs: 2 * DAY }), // dia 3: +4 → +5
    ];
    const r = computeSolBenchmark(trades, new Map(), noWindow);
    expect(r.points.map((p) => p.portfolioInSol)).toEqual([
      '-2.0000',
      '1.0000',
      '5.0000',
    ]);
  });

  it('perna em stablecoin é convertida ao preço do SOL do dia', () => {
    // Gasta 200 USDC; recebe 500 USDC. SOL=100 USD nos dois dias.
    // → −2 SOL na compra, +5 SOL na venda, fluxo líquido +3 SOL.
    const trades = [
      trade({
        side: 'BUY',
        quoteMint: USDC,
        quoteAmount: '200',
        blockTimeMs: 0,
      }),
      trade({
        side: 'SELL',
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

  it('janela: conta só trades com blockTime dentro da janela', () => {
    // Compra fora da janela (−2, ignorada) e venda dentro (+5) → +5 SOL na janela.
    const trades = [
      trade({ side: 'BUY', quoteAmount: '2', blockTimeMs: 0 }),
      trade({ side: 'SELL', quoteAmount: '5', blockTimeMs: 10 * DAY }),
    ];
    const r = computeSolBenchmark(trades, new Map(), {
      windowStart: new Date(5 * DAY),
      tzOffsetMinutes: 0,
    });
    expect(r.points).toHaveLength(1);
    expect(r.points[0].portfolioInSol).toBe('5.0000');
  });

  it('quote desconhecida não distorce (contribui 0 SOL)', () => {
    const trades = [
      trade({
        side: 'BUY',
        quoteMint: 'XyZ',
        quoteAmount: '5',
        blockTimeMs: 0,
      }),
      trade({
        side: 'SELL',
        quoteMint: 'XyZ',
        quoteAmount: '9',
        blockTimeMs: DAY,
      }),
    ];
    const r = computeSolBenchmark(trades, new Map(), noWindow);
    expect(r.available).toBe(false);
    expect(r.points).toHaveLength(0);
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
