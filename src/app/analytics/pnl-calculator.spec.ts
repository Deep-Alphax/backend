import { TradeSide } from '@prisma/client';
import {
  computePnl,
  computeClosedPositions,
  computeOpenPositions,
} from './pnl-calculator';
import { TradeInput } from './pnl-types';

const BASE = new Date('2026-07-01T10:00:00Z').getTime();
const H = 3600 * 1000;

function trade(
  side: TradeSide,
  amount: number,
  price: number,
  offsetHours: number,
  opts: Partial<TradeInput> & { mint?: string; symbol?: string } = {},
): TradeInput {
  return {
    blockTime: new Date(BASE + offsetHours * H),
    side,
    baseMint: opts.mint ?? 'TOK',
    baseSymbol: opts.symbol ?? 'TOK',
    baseAmount: String(amount),
    usdValue: opts.usdValue ?? String(amount * price),
    priceUsd: String(price),
    feeUsd: opts.feeUsd ?? '0',
    priceResolved: opts.priceResolved ?? true,
  };
}
const buy = (a: number, p: number, off: number, o = {}) =>
  trade(TradeSide.BUY, a, p, off, o);
const sell = (a: number, p: number, off: number, o = {}) =>
  trade(TradeSide.SELL, a, p, off, o);
const ALL = { windowStart: null, tzOffsetMinutes: 0 };

describe('computePnl', () => {
  it('retorna resultado vazio determinístico sem trades', () => {
    const r = computePnl([], ALL);
    expect(r.totalTrades).toBe(0);
    expect(r.realizedPnlUsd).toBe('0.00');
    expect(r.hourly).toHaveLength(24);
    expect(r.perToken).toEqual([]);
    expect(r.confidence.priceResolvedPct).toBe(100);
  });

  it('FIFO: casa venda contra os lotes de compra mais antigos primeiro', () => {
    const r = computePnl([buy(10, 1, 0), buy(10, 2, 1), sell(15, 3, 2)], ALL);
    // 10*(3-1) + 5*(3-2) = 25
    expect(r.realizedPnlUsd).toBe('25.00');
    expect(r.buys).toBe(2);
    expect(r.sells).toBe(1);
    expect(r.totalTrades).toBe(3);
  });

  it('separa hold time de winners e losers (ponderado por quantidade)', () => {
    // Venda 1 (winner) casa lote antigo (2h) e parte do novo (1h) → 6000s
    // Venda 2 (loser) casa o resto do lote novo (2h a partir da compra) → 7200s
    const r = computePnl(
      [buy(10, 1, 0), buy(10, 2, 1), sell(15, 3, 2), sell(5, 0.5, 3)],
      ALL,
    );
    expect(r.avgHoldSecondsWinners).toBe(6000);
    expect(r.avgHoldSecondsLosers).toBe(7200);
    expect(r.realizedPnlUsd).toBe('17.50'); // 25 + (5*(0.5-2)) = 25 - 7.5
    expect(r.netPnlUsd).toBe('17.50');
  });

  it('venda sem lote vira WINDFALL (não PnL de trading) e conta como unmatched', () => {
    const r = computePnl([sell(5, 2, 0)], ALL);
    expect(r.realizedPnlUsd).toBe('0.00'); // só trading casado; windfall não entra no Resultado
    expect(r.tradingPnlUsd).toBe('0.00'); // nada casado → 0 de trading
    expect(r.windfallProceedsUsd).toBe('10.00'); // proceeds "de graça" (reportado à parte)
    expect(r.confidence.unmatchedSellCount).toBe(1);
    expect(r.avgHoldSecondsWinners).toBeNull();
  });

  it('separa trading (casado) de windfall (sem base) numa venda mista', () => {
    // Compra 10@1; vende 15@3: 10 casam (trading = 10*(3-1)=20), 5 sem lote (windfall = 5*3=15)
    const r = computePnl([buy(10, 1, 0), sell(15, 3, 1)], ALL);
    expect(r.tradingPnlUsd).toBe('20.00');
    expect(r.windfallProceedsUsd).toBe('15.00');
    expect(r.realizedPnlUsd).toBe('20.00'); // Resultado = só trading (exclui o windfall de 15)
    expect(r.netPnlUsd).toBe('20.00'); // líquido de trading (sem fees)
    expect(r.confidence.unmatchedSellCount).toBe(1);
  });

  it('windfall (venda sem compra) NÃO entra na curva de capital nem no Resultado', () => {
    // Regressão do bug "evolução do capital contava saque/transferência": um token que
    // apareceu na carteira sem compra (transferência de outra carteira, airdrop, mint) e
    // foi vendido gera WINDFALL — não é trade e não pode inflar a curva/Resultado.
    const day2 = 24;
    const r = computePnl(
      [
        buy(10, 1, 0, { mint: 'REAL', symbol: 'REAL' }),
        sell(10, 3, 2, { mint: 'REAL', symbol: 'REAL' }), // dia 1: +20 de trading real
        sell(5, 4, day2, { mint: 'GIFT', symbol: 'GIFT' }), // dia 2: 20 de windfall (custo 0)
      ],
      ALL,
    );
    // Resultado reflete só o trade real (+20); os 20 de windfall ficam à parte.
    expect(r.realizedPnlUsd).toBe('20.00');
    expect(r.tradingPnlUsd).toBe('20.00');
    expect(r.windfallProceedsUsd).toBe('20.00');
    // Acumulado: 20 no dia 1 e CONTINUA 20 no dia 2 (o windfall não soma).
    expect(r.capital.points.map((p) => p.cumulativePnlUsd)).toEqual([
      '20.00',
      '20.00',
    ]);
    expect(r.capital.daysInGreen).toBe(1); // dia do windfall não é "dia no verde"
    expect(r.perDay.worstDay?.realizedPnlUsd).toBe('0.00'); // dia do windfall = 0, não +20
  });

  it('atribui PnL só na janela, mas usa compras anteriores para a base de custo', () => {
    // Compra fora da janela, venda dentro → PnL contabiliza mesmo com a compra antiga.
    const windowStart = new Date(BASE + 1.5 * H);
    const r = computePnl([buy(10, 1, 0), sell(10, 3, 2)], {
      windowStart,
      tzOffsetMinutes: 0,
    });
    expect(r.buys).toBe(0); // compra fora da janela não conta como trade
    expect(r.sells).toBe(1);
    expect(r.realizedPnlUsd).toBe('20.00'); // base de custo veio da compra pré-janela
    expect(r.confidence.unmatchedSellCount).toBe(0);
  });

  it('calcula fee % do volume e net PnL', () => {
    const r = computePnl(
      [buy(10, 1, 0, { feeUsd: '1' }), sell(10, 2, 1, { feeUsd: '1' })],
      ALL,
    );
    expect(r.feesUsd).toBe('2.00');
    expect(r.volumeUsd).toBe('30.00'); // 10 + 20
    expect(r.feePctOfVolume).toBeCloseTo(6.6667, 3);
    expect(r.realizedPnlUsd).toBe('10.00');
    expect(r.netPnlUsd).toBe('8.00'); // 10 - 2
  });

  it('bucketiza por hora do dia aplicando o offset de fuso', () => {
    // 10:00 UTC → 07:00 em BRT (-180 min)
    const r = computePnl([buy(1, 1, 0)], {
      windowStart: null,
      tzOffsetMinutes: -180,
    });
    const active = r.hourly.filter((h) => h.trades > 0);
    expect(active).toHaveLength(1);
    expect(active[0].hour).toBe(7);
  });

  it('agrupa por dia e identifica best/worst day', () => {
    // Dia 1: venda lucrativa; Dia 2: venda com prejuízo
    const day2 = 24;
    const r = computePnl(
      [buy(10, 1, 0), sell(10, 3, 2), buy(10, 5, day2), sell(10, 1, day2 + 1)],
      ALL,
    );
    expect(r.daily).toHaveLength(2);
    expect(r.perDay.activeDays).toBe(2);
    expect(r.perDay.bestDay?.realizedPnlUsd).toBe('20.00');
    expect(r.perDay.worstDay?.realizedPnlUsd).toBe('-40.00');
  });

  it('detecta trades imediatamente após uma perda (revenge trading)', () => {
    // sell perdedora (offset2), depois um BUY (offset3) → 1 trade após perda
    const r = computePnl([buy(10, 5, 0), sell(10, 3, 2), buy(1, 100, 3)], ALL);
    expect(r.tradesAfterLoss.count).toBe(1);
    // O trade seguinte é uma compra (realized 0) → não conta como winner/loser
    expect(r.tradesAfterLoss.winners).toBe(0);
    expect(r.tradesAfterLoss.losers).toBe(0);
  });

  it('não marca trade-após-perda quando a venda anterior foi lucrativa', () => {
    const r = computePnl([buy(10, 1, 0), sell(10, 3, 2), buy(1, 1, 3)], ALL);
    expect(r.tradesAfterLoss.count).toBe(0);
  });

  it('agrega entradas (quanto investiu) por token', () => {
    const r = computePnl(
      [
        buy(10, 1, 0, { mint: 'AAA', symbol: 'AAA' }),
        buy(5, 4, 1, { mint: 'BBB', symbol: 'BBB' }),
        buy(10, 1, 2, { mint: 'AAA', symbol: 'AAA' }),
      ],
      ALL,
    );
    expect(r.entrySizes.totalBuyUsd).toBe('40.00'); // 10 + 20 + 10
    expect(r.entrySizes.avgBuyUsd).toBe('13.33'); // 40 / 3
    const aaa = r.entrySizes.byToken.find((t) => t.mint === 'AAA');
    expect(aaa?.buyUsd).toBe('20.00');
    expect(aaa?.buys).toBe(2);
  });

  it('reporta confiança pela fração de trades com preço resolvido', () => {
    const r = computePnl(
      [
        buy(10, 1, 0, { priceResolved: true }),
        sell(10, 2, 1, { priceResolved: false }),
      ],
      ALL,
    );
    expect(r.confidence.priceResolvedPct).toBe(50);
  });

  it('produz breakdown por token ordenado por PnL desc', () => {
    const r = computePnl(
      [
        buy(10, 1, 0, { mint: 'WIN', symbol: 'WIN' }),
        sell(10, 3, 1, { mint: 'WIN', symbol: 'WIN' }),
        buy(10, 5, 0, { mint: 'LOSE', symbol: 'LOSE' }),
        sell(10, 1, 1, { mint: 'LOSE', symbol: 'LOSE' }),
      ],
      ALL,
    );
    expect(r.perToken[0].mint).toBe('WIN');
    expect(r.perToken[0].realizedPnlUsd).toBe('20.00');
    expect(r.perToken[1].mint).toBe('LOSE');
    expect(r.perToken[1].realizedPnlUsd).toBe('-40.00');
  });

  it('ordena trades fora de ordem antes de processar (base de custo correta)', () => {
    // Entrada embaralhada: venda listada antes das compras, mas cronologicamente depois.
    const r = computePnl([sell(15, 3, 2), buy(10, 2, 1), buy(10, 1, 0)], ALL);
    expect(r.realizedPnlUsd).toBe('25.00'); // mesmo resultado do caso FIFO ordenado
  });

  it('inclui o campo method descrevendo a metodologia', () => {
    const r = computePnl([buy(1, 1, 0)], ALL);
    expect(r.method).toMatch(/FIFO/);
  });

  // ─────────────────── Métricas de perfil (Bloco 1) ───────────────────

  it('win rate: winners / (winners + losers) sobre posições fechadas', () => {
    // 2 vendas lucrativas, 1 perdedora → 2/3 = 66,67%
    const r = computePnl(
      [
        buy(10, 1, 0, { mint: 'A', symbol: 'A' }),
        sell(10, 3, 1, { mint: 'A', symbol: 'A' }), // +20 winner
        buy(10, 1, 0, { mint: 'B', symbol: 'B' }),
        sell(10, 2, 1, { mint: 'B', symbol: 'B' }), // +10 winner
        buy(10, 5, 0, { mint: 'C', symbol: 'C' }),
        sell(10, 1, 1, { mint: 'C', symbol: 'C' }), // -40 loser
      ],
      ALL,
    );
    expect(r.winRate.closed).toBe(3);
    expect(r.winRate.winners).toBe(2);
    expect(r.winRate.losers).toBe(1);
    expect(r.winRate.winRatePct).toBeCloseTo(66.67, 1);
  });

  it('concentração do lucro: top3 / 4–10 / resto somam 100% do total', () => {
    // 4 vendas lucrativas: 100, 40, 20, 10 (custo 0 via lote a preço 1 → simples)
    const mk = (pnl: number, i: number) => [
      buy(1, 1, i * 2, { mint: `T${i}`, symbol: `T${i}` }),
      sell(1, 1 + pnl, i * 2 + 1, { mint: `T${i}`, symbol: `T${i}` }),
    ];
    const r = computePnl(
      [...mk(100, 0), ...mk(40, 1), ...mk(20, 2), ...mk(10, 3)],
      ALL,
    );
    expect(r.profitConcentration.totalUsd).toBe('170.00');
    expect(r.profitConcentration.top3.count).toBe(3);
    expect(r.profitConcentration.top3.pnlUsd).toBe('160.00'); // 100+40+20
    expect(r.profitConcentration.top3.pct).toBeCloseTo(94.12, 1);
    // O 4º trade cai no bucket "4–10" (next7); com só 4 trades, "resto" fica vazio.
    expect(r.profitConcentration.next7.count).toBe(1);
    expect(r.profitConcentration.next7.pnlUsd).toBe('10.00');
    expect(r.profitConcentration.rest.count).toBe(0);
    expect(r.profitConcentration.rest.pnlUsd).toBe('0.00');
  });

  it('concentração usa o LUCRO BRUTO (só ganhos): %s não explodem com líquido ~0', () => {
    // 3 ganhos (100+50+30 = 180 bruto) e 2 perdas (−85 cada) → líquido só 10.
    // Antes (÷ líquido) dava %s absurdas (1800%, …); agora ÷ bruto → 0–100%.
    const winner = (pnl: number, i: number) => [
      buy(1, 1, i * 2, { mint: `W${i}`, symbol: `W${i}` }),
      sell(1, 1 + pnl, i * 2 + 1, { mint: `W${i}`, symbol: `W${i}` }),
    ];
    const loser = (loss: number, i: number) => [
      buy(1, 100, i * 2, { mint: `L${i}`, symbol: `L${i}` }),
      sell(1, 100 - loss, i * 2 + 1, { mint: `L${i}`, symbol: `L${i}` }),
    ];
    const r = computePnl(
      [
        ...winner(100, 0),
        ...winner(50, 1),
        ...winner(30, 2),
        ...loser(85, 3),
        ...loser(85, 4),
      ],
      ALL,
    );

    expect(r.tradingPnlUsd).toBe('10.00'); // líquido pequeno (180 − 170)
    expect(r.profitConcentration.totalUsd).toBe('180.00'); // denominador = lucro BRUTO
    expect(r.profitConcentration.closedTrades).toBe(5); // total fechado (contexto)
    expect(r.profitConcentration.top3.count).toBe(3);
    expect(r.profitConcentration.top3.pnlUsd).toBe('180.00');
    expect(r.profitConcentration.top3.pct).toBeCloseTo(100, 1); // não 1800%
    expect(r.profitConcentration.next7.count).toBe(0);
    expect(r.profitConcentration.rest.count).toBe(0);
    // nenhum bucket ultrapassa 100% nem fica negativo.
    for (const b of [
      r.profitConcentration.top3,
      r.profitConcentration.next7,
      r.profitConcentration.rest,
    ]) {
      expect(b.pct).toBeGreaterThanOrEqual(0);
      expect(b.pct).toBeLessThanOrEqual(100);
    }
  });

  it('desfecho por múltiplo classifica rugpull/stop/1-2x/2-5x/5x+', () => {
    // custo 1 em todos; venda define o múltiplo
    const mk = (sellPrice: number, i: number) => [
      buy(1, 1, i * 2, { mint: `M${i}`, symbol: `M${i}` }),
      sell(1, sellPrice, i * 2 + 1, { mint: `M${i}`, symbol: `M${i}` }),
    ];
    const r = computePnl(
      [
        ...mk(0.05, 0), // rugpull (<0.1)
        ...mk(0.5, 1), // stop_loss
        ...mk(1.5, 2), // x1_2
        ...mk(3, 3), // x2_5
        ...mk(8, 4), // x5_plus
      ],
      ALL,
    );
    const by = Object.fromEntries(r.outcomes.map((o) => [o.bucket, o.count]));
    expect(by.rugpull).toBe(1);
    expect(by.stop_loss).toBe(1);
    expect(by.x1_2).toBe(1);
    expect(by.x2_5).toBe(1);
    expect(by.x5_plus).toBe(1);
    expect(r.outcomes).toHaveLength(5);
  });

  it('curva de capital: acumulado, drawdown e dias no verde', () => {
    const day2 = 24;
    const r = computePnl(
      [
        buy(10, 1, 0),
        sell(10, 3, 2), // dia 1: +20
        buy(10, 5, day2),
        sell(10, 1, day2 + 1), // dia 2: -40
      ],
      ALL,
    );
    expect(r.capital.points.map((p) => p.cumulativePnlUsd)).toEqual([
      '20.00',
      '-20.00',
    ]);
    expect(r.capital.maxDrawdownUsd).toBe('40.00'); // pico 20 → vale -20
    expect(r.capital.daysInGreen).toBe(1);
  });

  it('bankroll = pico do capital investido; resultado e drawdown em %', () => {
    // Deployed: +100 (buy 100@1), +200 (buy 100@2) = pico 300, −600 (sell 200@3).
    // Realizado: (3-1)*100 + (3-2)*100 = 300.
    const r = computePnl(
      [buy(100, 1, 0), buy(100, 2, 1), sell(200, 3, 2)],
      ALL,
    );
    expect(r.bankroll.peakDeployedUsd).toBe('300.00');
    expect(r.realizedPnlUsd).toBe('300.00');
    expect(r.bankroll.pnlPctOfBankroll).toBeCloseTo(100, 5); // 300 / 300
  });

  it('bankroll nulo em % quando não houve capital investido', () => {
    const r = computePnl([sell(5, 2, 0)], ALL); // só windfall, sem compra
    expect(r.bankroll.peakDeployedUsd).toBe('0.00');
    expect(r.bankroll.pnlPctOfBankroll).toBeNull();
  });

  it('extrai posições fechadas (FIFO) com entrada/saída p/ o engine de pico', () => {
    const r = computeClosedPositions(
      [buy(10, 1, 0), buy(10, 2, 1), sell(15, 3, 2)],
      ALL,
    );
    expect(r).toHaveLength(1);
    expect(r[0].qty).toBe(15);
    // custo médio casado = (10*1 + 5*2)/15 = 20/15 = 1.333...
    expect(r[0].entryPriceUsd).toBeCloseTo(1.3333, 3);
    expect(r[0].exitPriceUsd).toBe(3);
    expect(r[0].entryTimeMs).toBe(BASE); // lote mais antigo (offset 0)
  });

  it('bucketiza por dia da semana × bloco do dia (42 células)', () => {
    // BASE = 2026-07-01T10:00:00Z (quarta-feira). 10h → bloco 2 (08–12h). Qua = weekday 2.
    const r = computePnl([buy(10, 1, 0), sell(10, 3, 1)], ALL); // venda às 11h (bloco 2)
    expect(r.weekdayBlocks).toHaveLength(42);
    const cell = r.weekdayBlocks.find((c) => c.weekday === 2 && c.block === 2)!;
    expect(cell.trades).toBe(2); // compra 10h + venda 11h, ambos qua bloco 2
    expect(cell.realizedPnlUsd).toBe('20.00'); // (3-1)*10 na venda
    expect(cell.avgPnlPerTradeUsd).toBe('10.00'); // 20 / 2 trades
    // Células sem trade ficam zeradas.
    const empty = r.weekdayBlocks.find(
      (c) => c.weekday === 6 && c.block === 5,
    )!;
    expect(empty.trades).toBe(0);
    expect(empty.realizedPnlUsd).toBe('0.00');
  });

  it('resultado vazio traz as métricas de perfil zeradas', () => {
    const r = computePnl([], ALL);
    expect(r.winRate.winRatePct).toBe(0);
    expect(r.profitConcentration.totalUsd).toBe('0.00');
    expect(r.outcomes).toHaveLength(5);
    expect(r.capital.points).toEqual([]);
    expect(r.capital.maxDrawdownUsd).toBe('0.00');
  });
});

describe('computeOpenPositions', () => {
  it('posição parcialmente vendida → sobra qty com base de custo FIFO', () => {
    // Compra 10 @ $2; vende 4. Sobra 6 @ custo $2 = $12.
    const pos = computeOpenPositions([buy(10, 2, 0), sell(4, 3, 1)]);
    expect(pos).toHaveLength(1);
    expect(pos[0].mint).toBe('TOK');
    expect(Number(pos[0].qty)).toBeCloseTo(6, 9);
    expect(pos[0].costUsd).toBe('12.00');
  });

  it('posição totalmente vendida → não aparece', () => {
    expect(computeOpenPositions([buy(10, 2, 0), sell(10, 3, 1)])).toHaveLength(
      0,
    );
  });

  it('venda sem lote (windfall) NÃO gera posição negativa', () => {
    expect(computeOpenPositions([sell(5, 3, 0)])).toHaveLength(0);
  });

  it('custo da sobra é FIFO (consome o lote mais antigo primeiro)', () => {
    // Compra 10@$1, 10@$3; vende 5 (casa no lote de $1). Sobra 5@$1 + 10@$3 = $35.
    const pos = computeOpenPositions([
      buy(10, 1, 0),
      buy(10, 3, 1),
      sell(5, 5, 2),
    ]);
    expect(Number(pos[0].qty)).toBeCloseTo(15, 9);
    expect(pos[0].costUsd).toBe('35.00');
  });

  it('separa posições abertas por token', () => {
    const pos = computeOpenPositions([
      buy(10, 2, 0, { mint: 'AAA' }),
      buy(5, 4, 1, { mint: 'BBB' }),
      sell(10, 3, 2, { mint: 'AAA' }), // AAA zera
    ]);
    expect(pos).toHaveLength(1);
    expect(pos[0].mint).toBe('BBB');
    expect(pos[0].costUsd).toBe('20.00');
  });
});
