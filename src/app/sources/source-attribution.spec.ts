import { Chain } from '@prisma/client';
import { attributeBuys, UserBuy, LeadBuy } from './source-attribution';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 6, 1, 10, 0, 0); // 2026-07-01T10:00:00Z

const lead = (over: Partial<LeadBuy> = {}): LeadBuy => ({
  tradeId: 'L1',
  walletId: 'sw1',
  sourceId: 's1',
  mint: 'TOK',
  chain: Chain.SOLANA,
  blockTimeMs: T0,
  ...over,
});
const buy = (over: Partial<UserBuy> = {}): UserBuy => ({
  tradeId: 'B1',
  mint: 'TOK',
  chain: Chain.SOLANA,
  blockTimeMs: T0 + 2 * HOUR,
  ...over,
});

describe('attributeBuys (lead-lag)', () => {
  it('atribui a compra do usuário à fonte que comprou antes, dentro da janela', () => {
    const out = attributeBuys([buy()], [lead()], new Map([['s1', 6]]));
    expect(out).toEqual([
      {
        tradeId: 'B1',
        sourceId: 's1',
        leadTradeId: 'L1',
        leadWalletId: 'sw1',
        lagSeconds: 7200,
      },
    ]);
  });

  it('NÃO atribui quando a compra do usuário está fora da janela', () => {
    const out = attributeBuys(
      [buy({ blockTimeMs: T0 + 7 * HOUR })],
      [lead()],
      new Map([['s1', 6]]),
    );
    expect(out).toEqual([]);
  });

  it('NÃO atribui quando a fonte comprou DEPOIS do usuário', () => {
    const out = attributeBuys(
      [buy({ blockTimeMs: T0 })],
      [lead({ blockTimeMs: T0 + HOUR })],
      new Map([['s1', 6]]),
    );
    expect(out).toEqual([]);
  });

  it('casa múltiplas fontes que chamaram o mesmo token', () => {
    const leads = [
      lead({ tradeId: 'LA', sourceId: 'sA', walletId: 'wA', blockTimeMs: T0 }),
      lead({
        tradeId: 'LB',
        sourceId: 'sB',
        walletId: 'wB',
        blockTimeMs: T0 + HOUR,
      }),
    ];
    const out = attributeBuys(
      [buy({ blockTimeMs: T0 + 2 * HOUR })],
      leads,
      new Map([
        ['sA', 6],
        ['sB', 6],
      ]),
    );
    expect(out).toHaveLength(2);
    expect(out.find((a) => a.sourceId === 'sA')?.lagSeconds).toBe(7200);
    expect(out.find((a) => a.sourceId === 'sB')?.lagSeconds).toBe(3600);
  });

  it('escolhe a compra da fonte MAIS PRÓXIMA (menor defasagem)', () => {
    const leads = [
      lead({ tradeId: 'Lold', blockTimeMs: T0 }),
      lead({ tradeId: 'Lnew', blockTimeMs: T0 + HOUR }),
    ];
    const out = attributeBuys(
      [buy({ blockTimeMs: T0 + 2 * HOUR })],
      leads,
      new Map([['s1', 6]]),
    );
    expect(out).toHaveLength(1);
    expect(out[0].leadTradeId).toBe('Lnew');
    expect(out[0].lagSeconds).toBe(3600);
  });

  it('NÃO cruza chains: mesmo mint em chains diferentes é outro ativo', () => {
    const out = attributeBuys(
      [buy({ chain: Chain.ETHEREUM })],
      [lead({ chain: Chain.SOLANA })],
      new Map([['s1', 6]]),
    );
    expect(out).toEqual([]);
  });

  it('ignora fontes ausentes do mapa de janela (inativas)', () => {
    const out = attributeBuys([buy()], [lead()], new Map());
    expect(out).toEqual([]);
  });

  it('respeita a janela por fonte (janelas diferentes)', () => {
    const leads = [
      lead({ tradeId: 'LA', sourceId: 'sA', blockTimeMs: T0 }),
      lead({ tradeId: 'LB', sourceId: 'sB', blockTimeMs: T0 }),
    ];
    // Compra 5h depois: só a fonte com janela ≥5h casa.
    const out = attributeBuys(
      [buy({ blockTimeMs: T0 + 5 * HOUR })],
      leads,
      new Map([
        ['sA', 2],
        ['sB', 6],
      ]),
    );
    expect(out.map((a) => a.sourceId)).toEqual(['sB']);
  });
});
