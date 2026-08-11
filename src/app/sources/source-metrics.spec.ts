import { TradeSide } from '@prisma/client';
import { CandlePoint } from '../analytics/profile-metrics.types';
import {
  computeSourceBreakdown,
  recommend,
  SourceTradeInput,
  SourceMeta,
} from './source-metrics';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 6, 1, 10, 0, 0);

const t = (
  over: Partial<SourceTradeInput> & Pick<SourceTradeInput, 'id' | 'side'>,
): SourceTradeInput => ({
  mint: 'TOK',
  symbol: 'TOK',
  blockTimeMs: T0,
  baseAmount: '10',
  priceUsd: '1',
  ...over,
});

const SOURCES: SourceMeta[] = [
  { id: 's1', name: 'A' },
  { id: 's2', name: 'B' },
];

describe('computeSourceBreakdown', () => {
  it('atribui fatias FIFO por fonte e agrega PnL/winrate/mediana', () => {
    const trades: SourceTradeInput[] = [
      t({
        id: 'b1',
        side: TradeSide.BUY,
        baseAmount: '10',
        priceUsd: '1',
        blockTimeMs: T0,
      }),
      t({
        id: 'b2',
        side: TradeSide.BUY,
        baseAmount: '10',
        priceUsd: '2',
        blockTimeMs: T0 + HOUR,
      }),
      t({
        id: 's',
        side: TradeSide.SELL,
        baseAmount: '15',
        priceUsd: '3',
        blockTimeMs: T0 + 2 * HOUR,
      }),
    ];
    const attribution = new Map<string, string[]>([
      ['b1', ['s1']],
      ['b2', ['s2']],
    ]);

    const rows = computeSourceBreakdown(trades, attribution, SOURCES, {
      windowStart: null,
    });

    // Ordena por trades desc, depois PnL desc → s1 (PnL 20) antes de s2 (PnL 5).
    const s1 = rows.find((r) => r.id === 's1')!;
    const s2 = rows.find((r) => r.id === 's2')!;
    expect(rows[0].id).toBe('s1');
    // Venda de 15 casa 10 do lote b1 (@1) + 5 do lote b2 (@2).
    expect(s1).toMatchObject({
      trades: 1,
      pnlUsd: '20.00',
      winRatePct: 100,
      medianExitMultiple: 3,
    });
    expect(s2).toMatchObject({
      trades: 1,
      pnlUsd: '5.00',
      winRatePct: 100,
      medianExitMultiple: 1.5,
    });
    // Sem candles → capture null.
    expect(s1.capture).toBeNull();
  });

  it('inclui fontes sem trades atribuídos (zeradas → observar)', () => {
    const trades: SourceTradeInput[] = [
      t({ id: 'b1', side: TradeSide.BUY }),
      t({
        id: 's',
        side: TradeSide.SELL,
        priceUsd: '2',
        blockTimeMs: T0 + HOUR,
      }),
    ];
    const attribution = new Map<string, string[]>([['b1', ['s1']]]);
    const rows = computeSourceBreakdown(trades, attribution, SOURCES, {
      windowStart: null,
    });

    const s2 = rows.find((r) => r.id === 's2')!;
    expect(s2).toMatchObject({
      trades: 0,
      pnlUsd: '0.00',
      winRatePct: 0,
      recommendation: 'observar',
    });
  });

  it('respeita a janela: ignora vendas anteriores ao windowStart', () => {
    const trades: SourceTradeInput[] = [
      t({ id: 'b1', side: TradeSide.BUY, blockTimeMs: T0 }),
      t({
        id: 's',
        side: TradeSide.SELL,
        priceUsd: '2',
        blockTimeMs: T0 + HOUR,
      }),
    ];
    const attribution = new Map<string, string[]>([['b1', ['s1']]]);
    // Janela começa DEPOIS da venda → nenhuma fatia emitida.
    const rows = computeSourceBreakdown(trades, attribution, SOURCES, {
      windowStart: new Date(T0 + 2 * HOUR),
    });
    expect(rows.find((r) => r.id === 's1')!.trades).toBe(0);
  });

  it('conta a mesma fatia para todas as fontes atribuídas àquela compra', () => {
    const trades: SourceTradeInput[] = [
      t({ id: 'b1', side: TradeSide.BUY, blockTimeMs: T0 }),
      t({
        id: 's',
        side: TradeSide.SELL,
        priceUsd: '2',
        blockTimeMs: T0 + HOUR,
      }),
    ];
    const attribution = new Map<string, string[]>([['b1', ['s1', 's2']]]);
    const rows = computeSourceBreakdown(trades, attribution, SOURCES, {
      windowStart: null,
    });
    expect(rows.find((r) => r.id === 's1')!.trades).toBe(1);
    expect(rows.find((r) => r.id === 's2')!.trades).toBe(1);
  });

  it('calcula capture quando há candles (topo pós-entrada)', () => {
    const trades: SourceTradeInput[] = [
      t({
        id: 'b1',
        side: TradeSide.BUY,
        baseAmount: '10',
        priceUsd: '1',
        blockTimeMs: T0,
      }),
      t({
        id: 's',
        side: TradeSide.SELL,
        baseAmount: '10',
        priceUsd: '2',
        blockTimeMs: T0 + 2 * HOUR,
      }),
    ];
    const attribution = new Map<string, string[]>([['b1', ['s1']]]);
    // Pico de $4 na janela do hold → captura (2−1)/(4−1) = 33,33%.
    const candles = new Map<string, CandlePoint[]>([
      ['TOK', [{ timeMs: T0 + HOUR, high: 4 }]],
    ]);
    const rows = computeSourceBreakdown(
      trades,
      attribution,
      SOURCES,
      { windowStart: null },
      candles,
    );
    const s1 = rows.find((r) => r.id === 's1')!;
    expect(s1.capture).not.toBeNull();
    expect(s1.capture!.pct).toBeCloseTo(33.33, 1);
    expect(s1.capture!.onTarget).toBe(false);
  });
});

describe('recommend (heurística)', () => {
  const base = {
    trades: 10,
    winRatePct: 50,
    pnlNum: 10,
    medianExitMultiple: 2,
    capturePct: 60 as number | null,
  };

  it('amostra pequena → observar', () => {
    expect(recommend({ ...base, trades: 3 })).toBe('observar');
  });
  it('perde muito e erra muito → cortar', () => {
    expect(recommend({ ...base, pnlNum: -5, winRatePct: 20 })).toBe('cortar');
  });
  it('perde mas acerta razoável → reduzir_size', () => {
    expect(recommend({ ...base, pnlNum: -5, winRatePct: 50 })).toBe(
      'reduzir_size',
    );
  });
  it('lucra mas aproveita pouco o topo → revisar_entrada', () => {
    expect(recommend({ ...base, winRatePct: 70, capturePct: 20 })).toBe(
      'revisar_entrada',
    );
  });
  it('lucra, acerta muito e segura o alvo → usar_mais', () => {
    expect(recommend({ ...base, winRatePct: 65, capturePct: null })).toBe(
      'usar_mais',
    );
    expect(recommend({ ...base, winRatePct: 65, capturePct: 55 })).toBe(
      'usar_mais',
    );
  });
  it('lucra com acerto aceitável → manter', () => {
    expect(recommend({ ...base, winRatePct: 50, capturePct: null })).toBe(
      'manter',
    );
  });
  it('lucra com baixo acerto e mediana < 1 → revisar_entrada', () => {
    expect(
      recommend({
        ...base,
        winRatePct: 40,
        capturePct: null,
        medianExitMultiple: 0.8,
      }),
    ).toBe('revisar_entrada');
  });
  it('lucra com baixo acerto puxado por poucos acertos grandes → aposta_curta', () => {
    expect(
      recommend({
        ...base,
        winRatePct: 40,
        capturePct: null,
        medianExitMultiple: 5,
      }),
    ).toBe('aposta_curta');
  });
});
