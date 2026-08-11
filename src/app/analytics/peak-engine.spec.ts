import { computePeakMetrics, buildBenchmark, computeSurvival } from './peak-engine';
import { ClosedPosition, CandlePoint } from './profile-metrics.types';

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
      pos({ mint: 'A', entryPriceUsd: 1, exitPriceUsd: 3, qty: 10, exitTimeMs: 100 }),
      // Subiu 3x e capturou só 10% (saída 1,2x): devolveu.
      pos({ mint: 'B', symbol: 'B', entryPriceUsd: 1, exitPriceUsd: 1.2, qty: 5, exitTimeMs: 200 }),
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
    const candles = new Map<string, CandlePoint[]>([['A', [{ timeMs: 50, high: 4 }]]]);
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

describe('computeSurvival', () => {
  it('taxa de sobrevida sobre tokens de status conhecido', () => {
    const r = computeSurvival(['alive', 'alive', 'dead', 'unknown']);
    expect(r.alive).toBe(2);
    expect(r.dead).toBe(1);
    expect(r.unknown).toBe(1);
    expect(r.alivePct).toBeCloseTo(66.67, 1); // 2 / (2+1)
  });
});
