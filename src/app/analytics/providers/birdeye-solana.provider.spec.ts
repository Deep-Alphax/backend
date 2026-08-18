import { of } from 'rxjs';
import { Chain, TradeSide } from '@prisma/client';
import { BirdeyeSolanaProvider } from './birdeye-solana.provider';

/**
 * Foco: paginação por TEMPO (`before_time`) em vez de offset. O Birdeye rejeita
 * offset > 10.000 (422) — carteiras muito ativas estouravam. Estes testes travam
 * o novo comportamento e a compat com cursores antigos (que eram offset).
 */
const A = '2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f';

function mkItem(tsSec: number, side: 'BUY' | 'SELL' = 'BUY') {
  return {
    tx_hash: `h${tsSec}`,
    block_unix_time: tsSec,
    base: {
      address: 'BASEmint',
      symbol: 'B',
      ui_amount: 100,
      ui_change_amount: side === 'BUY' ? 100 : -100,
      price: 1,
    },
    quote: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL', ui_amount: 1 },
    volume_usd: 50,
    source: 'x',
  };
}

/** Provider com http mockado; `cap.params` captura os params da última chamada. */
function make(items: any[], cap: { params?: any }) {
  const http: any = {
    get: jest.fn((_url: string, opts: any) => {
      cap.params = opts?.params;
      return of({ data: { data: { items } } });
    }),
  };
  const config: any = {
    get: (k: string) => (k === 'BIRDEYE_API_KEY' ? 'key' : undefined),
  };
  return new BirdeyeSolanaProvider(config, http);
}

describe('BirdeyeSolanaProvider.fetchSwaps (paginação por before_time)', () => {
  it('1ª página: sem cursor → sem before_time; nextCursor = mais_antigo − 1', async () => {
    const cap: any = {};
    const provider = make([mkItem(1_700_000_100), mkItem(1_700_000_050)], cap);
    const res = await provider.fetchSwaps({ chain: Chain.SOLANA, address: A, limit: 2 });

    expect(cap.params.before_time).toBeUndefined(); // 1ª página
    expect(cap.params.offset).toBeUndefined(); // NÃO usa mais offset
    expect(res.swaps).toHaveLength(2);
    expect(res.swaps[0].side).toBe(TradeSide.BUY);
    expect(res.nextCursor).toBe(String(1_700_000_050 - 1)); // página cheia → continua
  });

  it('página seguinte: cursor de timestamp → vira before_time na query', async () => {
    const cap: any = {};
    const provider = make([mkItem(1_699_999_000)], cap);
    await provider.fetchSwaps({
      chain: Chain.SOLANA,
      address: A,
      limit: 2,
      cursor: '1700000000',
    });
    expect(cap.params.before_time).toBe('1700000000');
  });

  it('COMPAT: cursor antigo em OFFSET (< 1e9) é ignorado → recomeça do topo', async () => {
    const cap: any = {};
    const provider = make([mkItem(1_700_000_100)], cap);
    await provider.fetchSwaps({
      chain: Chain.SOLANA,
      address: A,
      limit: 2,
      cursor: '9900', // offset legado
    });
    expect(cap.params.before_time).toBeUndefined(); // não interpreta 9900 como tempo
  });

  it('piso da janela: item mais antigo que sinceBlockTime → para e não continua', async () => {
    const cap: any = {};
    // 2º item (1_700_000_050) é anterior ao piso (1_700_000_060) → reachedOld.
    const provider = make([mkItem(1_700_000_100), mkItem(1_700_000_050)], cap);
    const res = await provider.fetchSwaps({
      chain: Chain.SOLANA,
      address: A,
      limit: 2,
      sinceBlockTime: new Date(1_700_000_060 * 1000),
    });
    expect(res.swaps).toHaveLength(1); // só o dentro da janela
    expect(res.nextCursor).toBeNull(); // cruzou a janela → para
  });

  it('página não cheia → nextCursor null (fim do histórico)', async () => {
    const cap: any = {};
    const provider = make([mkItem(1_700_000_100)], cap); // 1 < limit 2
    const res = await provider.fetchSwaps({ chain: Chain.SOLANA, address: A, limit: 2 });
    expect(res.nextCursor).toBeNull();
  });
});
