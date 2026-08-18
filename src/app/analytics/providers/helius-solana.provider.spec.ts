import { of } from 'rxjs';
import { Chain, TradeSide } from '@prisma/client';
import { HeliusSolanaProvider } from './helius-solana.provider';

const WSOL = 'So11111111111111111111111111111111111111112';
const A = 'WALLET';
const MANLET = 'MANLETmint1111111111111111111111111111111111';

const secs = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/**
 * Prisma stub para os testes: cache de preços/dia SEMPRE vazio (miss) → o provider
 * cai no caminho de rede (CoinGecko/DexScreener/Jupiter), que é o que os testes
 * exercitam. `upsert`/`createMany` são no-ops resolvidos.
 */
function prismaMock(): any {
  const empty = { findMany: async () => [] };
  const read = { tokenPrice: empty, solDayPrice: empty };
  const write = {
    tokenPrice: { upsert: async () => ({}) },
    solDayPrice: { createMany: async () => ({}) },
  };
  return {
    getReadClient: () => read,
    getWriteClient: () => write,
  };
}

function makeProvider(txs: any[]) {
  // Roteia por URL: transações do Helius, preço do SOL/dia do CoinGecko, DexScreener.
  // CoinGecko: 190 em 2026-08-10, 200 em 2026-08-11 (ponto ao meio-dia de cada).
  const http: any = {
    get: jest.fn().mockImplementation((url: string) => {
      if (url.includes('/coins/solana/market_chart/range')) {
        return of({
          data: {
            prices: [
              [Date.parse('2026-08-10T12:00:00Z'), 190],
              [Date.parse('2026-08-11T12:00:00Z'), 200],
            ],
          },
        });
      }
      if (url.includes('dexscreener.com')) return of({ data: { pairs: [] } });
      return of({ data: txs }); // Helius /transactions
    }),
  };
  const config: any = {
    get: (k: string) => (k === 'HELIUS_API_KEY' ? 'key' : undefined),
  };
  const provider = new HeliusSolanaProvider(config, http, prismaMock());
  return { provider, http };
}

const sellTx = {
  signature: 'sigSELL',
  timestamp: secs('2026-08-11T03:25:14Z'),
  feePayer: A,
  fee: 234750,
  source: 'FLASHX',
  tokenTransfers: [
    {
      fromUserAccount: A,
      toUserAccount: 'X',
      mint: MANLET,
      tokenAmount: 81112.783003007,
    },
    {
      fromUserAccount: 'X',
      toUserAccount: A,
      mint: WSOL,
      tokenAmount: 7.081994875,
    },
  ],
  nativeTransfers: [],
};

const buyTx = {
  signature: 'sigBUY',
  timestamp: secs('2026-08-10T23:02:56Z'),
  feePayer: A,
  fee: 235148,
  source: 'FLASHX',
  tokenTransfers: [
    { fromUserAccount: A, toUserAccount: 'X', mint: WSOL, tokenAmount: 29.7 },
    {
      fromUserAccount: 'X',
      toUserAccount: A,
      mint: MANLET,
      tokenAmount: 365986.84,
    },
  ],
  nativeTransfers: [],
};

const transferTx = {
  signature: 'sigXfer',
  timestamp: secs('2026-08-11T01:00:00Z'),
  feePayer: A,
  fee: 5000,
  source: 'SYSTEM_PROGRAM',
  tokenTransfers: [
    { fromUserAccount: A, toUserAccount: 'Y', mint: MANLET, tokenAmount: 100 },
  ],
  nativeTransfers: [],
};

describe('HeliusSolanaProvider', () => {
  it('reconstrói SELL e BUY a partir dos tokenTransfers e ignora transfer simples', async () => {
    const { provider } = makeProvider([sellTx, buyTx, transferTx]);
    const res = await provider.fetchSwaps({ chain: Chain.SOLANA, address: A });

    expect(res.swaps).toHaveLength(2); // transfer simples descartado
    expect(res.nextCursor).toBeNull(); // página não veio cheia

    const sell = res.swaps.find((s) => s.txHash === 'sigSELL')!;
    expect(sell.side).toBe(TradeSide.SELL);
    expect(sell.baseMint).toBe(MANLET);
    expect(sell.baseAmount).toBe('81112.783003007');
    expect(sell.quoteMint).toBe(WSOL);
    expect(sell.quoteAmount).toBe('7.081994875');
    expect(sell.feeNative).toBe('0.00023475');
    expect(sell.priceResolved).toBe(true);
    // usdValue = 7.081994875 SOL × 200 (preço do dia 2026-08-11)
    expect(Number(sell.usdValue)).toBeCloseTo(7.081994875 * 200, 6);
    expect(Number(sell.feeUsd)).toBeCloseTo(0.00023475 * 200, 9);

    const buy = res.swaps.find((s) => s.txHash === 'sigBUY')!;
    expect(buy.side).toBe(TradeSide.BUY);
    expect(buy.baseMint).toBe(MANLET);
    expect(buy.quoteAmount).toBe('29.7');
    // usdValue = 29.7 SOL × 190 (preço do dia 2026-08-10)
    expect(Number(buy.usdValue)).toBeCloseTo(29.7 * 190, 6);
  });

  it('sem HELIUS_API_KEY lança erro transitório (status 401)', async () => {
    const http: any = { get: jest.fn() };
    const config: any = { get: () => undefined };
    const provider = new HeliusSolanaProvider(config, http, prismaMock());
    await expect(
      provider.fetchSwaps({ chain: Chain.SOLANA, address: A }),
    ).rejects.toMatchObject({ status: 401 });
    expect(http.get).not.toHaveBeenCalled();
  });

  it('paginação: página cheia devolve nextCursor = última assinatura', async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({
      ...sellTx,
      signature: `sig${i}`,
    }));
    const { provider } = makeProvider(page);
    const res = await provider.fetchSwaps({
      chain: Chain.SOLANA,
      address: A,
      limit: 100,
    });
    expect(res.nextCursor).toBe('sig99');
  });

  it('SOL: usa o DELTA NATIVO real (desconta taxa/tip) e não a perna WSOL bruta', async () => {
    // Venda estilo Axiom: perna WSOL bruta 10; nativo recebe 10 e paga 0,1 de fee →
    // delta nativo 9,9. quoteAmount deve ser 9,9 (líquido), não 10.
    const axiomSell = {
      signature: 'sigAxiom',
      timestamp: secs('2026-08-11T03:00:00Z'),
      feePayer: A,
      fee: 0,
      source: 'FLASHX',
      tokenTransfers: [
        {
          fromUserAccount: A,
          toUserAccount: 'P',
          mint: MANLET,
          tokenAmount: 1000,
        },
        { fromUserAccount: 'P', toUserAccount: A, mint: WSOL, tokenAmount: 10 },
      ],
      nativeTransfers: [
        { fromUserAccount: 'P', toUserAccount: A, amount: 10e9 }, // unwrap p/ nativo
        { fromUserAccount: A, toUserAccount: 'FEE', amount: 0.1e9 }, // taxa 1% em SOL
      ],
    };
    const { provider } = makeProvider([axiomSell]);
    const res = await provider.fetchSwaps({ chain: Chain.SOLANA, address: A });
    const s = res.swaps[0];
    expect(s.side).toBe(TradeSide.SELL);
    expect(s.quoteMint).toBe(WSOL);
    expect(Number(s.quoteAmount)).toBeCloseTo(9.9, 9); // 10 − 0,1 de taxa
  });

  it('REGRESSÃO: venda paga em SOL NATIVO (pump.fun) usa accountData.nativeBalanceChange', async () => {
    // Bug real: proventos em SOL nativo NÃO aparecem como nativeTransfer (só como
    // balance change). Somar transfers pegava só as taxas (saídas) → venda ~0
    // (prejuízo fantasma). Deve usar o Δnative do accountData = +0,334.
    const pumpSell = {
      signature: 'sigPump',
      timestamp: secs('2026-08-11T04:00:00Z'),
      feePayer: A,
      fee: 105000,
      source: 'PUMP_FUN',
      tokenTransfers: [
        {
          fromUserAccount: A,
          toUserAccount: 'P',
          mint: MANLET,
          tokenAmount: 4856394,
        },
        // SEM perna WSOL: o pool paga em SOL nativo.
      ],
      nativeTransfers: [
        { fromUserAccount: A, toUserAccount: 'TIP', amount: 0.0034e9 }, // só saídas de taxa
        { fromUserAccount: A, toUserAccount: 'FEE', amount: 0.001e9 },
      ],
      // Proventos reais SÓ aparecem aqui (mudança líquida de saldo).
      accountData: [{ account: A, nativeBalanceChange: 0.334653e9 }],
    };
    const { provider } = makeProvider([pumpSell]);
    const res = await provider.fetchSwaps({ chain: Chain.SOLANA, address: A });
    const s = res.swaps[0];
    expect(s.side).toBe(TradeSide.SELL);
    expect(s.quoteMint).toBe(WSOL);
    // Antes do fix: ~0,0044 (só taxas). Depois: 0,334653 (Δnative real).
    expect(Number(s.quoteAmount)).toBeCloseTo(0.334653, 6);
  });

  it('fetchTokenSnapshots via DexScreener: par de maior liquidez; mint sem par → null', async () => {
    // MANLET tem 2 pares (fica com o de maior liquidez); DEAD não tem par → null.
    const DEAD = 'DEADmint111111111111111111111111111111111111';
    const http: any = {
      get: jest.fn().mockImplementation((url: string) => {
        if (url.includes('dexscreener.com')) {
          return of({
            data: {
              pairs: [
                {
                  baseToken: { address: MANLET },
                  priceUsd: '0.0011',
                  liquidity: { usd: 5000 },
                },
                {
                  baseToken: { address: MANLET },
                  priceUsd: '0.0009',
                  liquidity: { usd: 20000 }, // maior liquidez → vence
                },
              ],
            },
          });
        }
        return of({ data: [] });
      }),
    };
    const config: any = { get: () => undefined };
    const provider = new HeliusSolanaProvider(config, http, prismaMock());

    const snaps = await provider.fetchTokenSnapshots(Chain.SOLANA, [
      MANLET,
      DEAD,
    ]);
    expect(snaps.get(MANLET)).toEqual({
      priceUsd: '0.0009',
      liquidityUsd: '20000',
    });
    expect(snaps.get(DEAD)).toBeNull();
  });
});
