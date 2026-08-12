import { of } from 'rxjs';
import { Chain, TradeSide } from '@prisma/client';
import { HeliusSolanaProvider } from './helius-solana.provider';

const WSOL = 'So11111111111111111111111111111111111111112';
const A = 'WALLET';
const MANLET = 'MANLETmint1111111111111111111111111111111111';

const secs = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function makeProvider(txs: any[]) {
  const http: any = { get: jest.fn().mockReturnValue(of({ data: txs })) };
  const config: any = {
    get: (k: string) => (k === 'HELIUS_API_KEY' ? 'key' : undefined),
  };
  // Moralis mockada só para o preço do SOL: 190 em 2026-08-10, 200 em 2026-08-11.
  const moralis: any = {
    fetchOhlc: jest.fn().mockResolvedValue([
      { openTime: new Date('2026-08-10T00:00:00Z'), open: '0', high: '0', low: '0', close: '190' },
      { openTime: new Date('2026-08-11T00:00:00Z'), open: '0', high: '0', low: '0', close: '200' },
    ]),
    fetchTokenSnapshot: jest.fn(),
  };
  const provider = new HeliusSolanaProvider(config, http, moralis);
  return { provider, http, moralis };
}

const sellTx = {
  signature: 'sigSELL',
  timestamp: secs('2026-08-11T03:25:14Z'),
  feePayer: A,
  fee: 234750,
  source: 'FLASHX',
  tokenTransfers: [
    { fromUserAccount: A, toUserAccount: 'X', mint: MANLET, tokenAmount: 81112.783003007 },
    { fromUserAccount: 'X', toUserAccount: A, mint: WSOL, tokenAmount: 7.081994875 },
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
    { fromUserAccount: 'X', toUserAccount: A, mint: MANLET, tokenAmount: 365986.84 },
  ],
  nativeTransfers: [],
};

const transferTx = {
  signature: 'sigXfer',
  timestamp: secs('2026-08-11T01:00:00Z'),
  feePayer: A,
  fee: 5000,
  source: 'SYSTEM_PROGRAM',
  tokenTransfers: [{ fromUserAccount: A, toUserAccount: 'Y', mint: MANLET, tokenAmount: 100 }],
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
    const provider = new HeliusSolanaProvider(config, http, {} as any);
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
    const res = await provider.fetchSwaps({ chain: Chain.SOLANA, address: A, limit: 100 });
    expect(res.nextCursor).toBe('sig99');
  });
});
