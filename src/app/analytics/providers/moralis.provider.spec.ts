import { of } from 'rxjs';
import { ServiceUnavailableException } from '@nestjs/common';
import { Chain, TradeSide } from '@prisma/client';
import { MoralisProvider } from './moralis.provider';

function makeProvider(apiKey = 'key', responseData: any = { result: [] }, rpcData: any = []) {
  const http: any = {
    get: jest.fn().mockReturnValue(of({ data: responseData })),
    // RPC Solana (getTransaction em lote) usado no enriquecimento de fee.
    post: jest.fn().mockReturnValue(of({ data: rpcData })),
  };
  const config: any = { get: (k: string) => (k === 'MORALIS_API_KEY' ? apiKey : undefined) };
  return { provider: new MoralisProvider(config, http), http };
}

describe('MoralisProvider', () => {
  it('lança ServiceUnavailable sem MORALIS_API_KEY', async () => {
    const { provider } = makeProvider('');
    await expect(
      provider.fetchSwaps({ chain: Chain.ETHEREUM, address: '0xabc' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('mapeia swap EVM de COMPRA (base = token comprado)', async () => {
    const data = {
      cursor: 'next-page',
      result: [
        {
          transactionType: 'buy',
          transactionHash: '0xhash',
          blockTimestamp: '2026-07-01T10:00:00Z',
          bought: { address: 'TOK', symbol: 'TOK', amount: '100', usdPrice: '2', usdAmount: '200' },
          sold: { address: 'USDC', symbol: 'USDC', amount: '200' },
          exchangeName: 'uniswap',
        },
      ],
    };
    const { provider } = makeProvider('key', data);
    const res = await provider.fetchSwaps({ chain: Chain.ETHEREUM, address: '0xabc' });

    expect(res.nextCursor).toBe('next-page');
    expect(res.swaps).toHaveLength(1);
    const s = res.swaps[0];
    expect(s.side).toBe(TradeSide.BUY);
    expect(s.baseMint).toBe('TOK');
    expect(s.baseAmount).toBe('100');
    expect(s.quoteMint).toBe('USDC');
    expect(s.quoteAmount).toBe('200');
    expect(s.priceUsd).toBe('2');
    expect(s.usdValue).toBe('200');
    expect(s.priceResolved).toBe(true);
    expect(s.dexProgram).toBe('uniswap');
  });

  it('mapeia swap EVM de VENDA (base = token vendido)', async () => {
    const data = {
      result: [
        {
          transactionType: 'sell',
          transactionHash: '0xhash2',
          blockTimestamp: '2026-07-01T11:00:00Z',
          bought: { address: 'USDC', symbol: 'USDC', amount: '300' },
          sold: { address: 'TOK', symbol: 'TOK', amount: '100', usdPrice: '3', usdAmount: '300' },
        },
      ],
    };
    const { provider } = makeProvider('key', data);
    const res = await provider.fetchSwaps({ chain: Chain.ETHEREUM, address: '0xabc' });
    const s = res.swaps[0];
    expect(s.side).toBe(TradeSide.SELL);
    expect(s.baseMint).toBe('TOK');
    expect(s.quoteMint).toBe('USDC');
    expect(s.priceUsd).toBe('3');
  });

  it('marca priceResolved=false quando não há usdPrice', async () => {
    const data = {
      result: [
        {
          transactionType: 'buy',
          transactionHash: '0xh',
          blockTimestamp: '2026-07-01T10:00:00Z',
          bought: { address: 'TOK', symbol: 'TOK', amount: '100' },
          sold: { address: 'WETH', symbol: 'WETH', amount: '1' },
        },
      ],
    };
    const { provider } = makeProvider('key', data);
    const res = await provider.fetchSwaps({ chain: Chain.ETHEREUM, address: '0xabc' });
    expect(res.swaps[0].priceResolved).toBe(false);
    expect(res.swaps[0].priceUsd).toBe('0');
  });

  it('descarta entradas sem side/hash/timestamp', async () => {
    const data = { result: [{ transactionType: 'unknown' }, { transactionHash: '0x', blockTimestamp: null }] };
    const { provider } = makeProvider('key', data);
    const res = await provider.fetchSwaps({ chain: Chain.ETHEREUM, address: '0xabc' });
    expect(res.swaps).toHaveLength(0);
  });

  it('roteia Solana para o endpoint do Solana Gateway', async () => {
    const data = {
      result: [
        {
          transactionType: 'buy',
          transactionHash: 'sig123',
          blockTimestamp: '2026-07-01T10:00:00Z',
          bought: { address: 'MINT', symbol: 'BONK', amount: '1000', usdPrice: '0.01', usdAmount: '10' },
          sold: { address: 'SOL', symbol: 'SOL', amount: '0.1' },
        },
      ],
    };
    const { provider, http } = makeProvider('key', data);
    const res = await provider.fetchSwaps({ chain: Chain.SOLANA, address: 'addr' });
    expect(res.swaps[0].baseSymbol).toBe('BONK');
    const calledUrl = http.get.mock.calls[0][0] as string;
    expect(calledUrl).toContain('solana-gateway.moralis.io');
  });

  it('enriquece a taxa Solana com meta.fee do RPC (lamports → SOL → USD)', async () => {
    const WSOL = 'So11111111111111111111111111111111111111112';
    const data = {
      result: [
        {
          transactionType: 'buy',
          transactionHash: 'sigFee',
          blockTimestamp: '2026-07-01T10:00:00Z',
          bought: { address: 'MINT', symbol: 'TOK', amount: '1000', usdPrice: '0.01', usdAmount: '10' },
          // lado SOL traz o preço do SOL usado na conversão da fee
          sold: { address: WSOL, symbol: 'SOL', amount: '0.08', usdPrice: '200' },
        },
      ],
    };
    // RPC devolve meta.fee = 625000 lamports (0.000625 SOL) para a assinatura idx 0
    const rpc = [{ id: 0, result: { meta: { fee: 625000 } } }];
    const { provider, http } = makeProvider('key', data, rpc);
    const res = await provider.fetchSwaps({ chain: Chain.SOLANA, address: 'addr' });
    expect(res.swaps[0].feeNative).toBe(String(0.000625));
    expect(Number(res.swaps[0].feeUsd)).toBeCloseTo(0.000625 * 200, 9); // 0.125
    expect(http.post).toHaveBeenCalled(); // bateu no RPC
  });
});
