import { Chain, ChainType } from '@prisma/client';
import { CandleService } from './candle.service';

/**
 * Foco: o NEGATIVE CACHE de candles (economia de chamadas à API paga do provider).
 * Regras exercitadas:
 *  - candle no banco → serve do banco, NÃO chama o provider;
 *  - sem candle mas janela já coberta (mesmo vazia) → serve []/DB, NÃO chama o provider;
 *  - sem candle e sem cobertura → chama o provider 1×, persiste e marca a cobertura;
 *  - janela pedida MAIS AMPLA que a coberta → cobre o buraco (chama o provider).
 */
function makeService(opts: {
  candles?: { openTime: Date; high: any; close: any }[];
  coverage?: { fromTime: Date; toTime: Date } | null;
  ohlc?: { openTime: Date; open: string; high: string; low: string; close: string }[];
}) {
  const findMany = jest.fn().mockResolvedValue(opts.candles ?? []);
  const findUnique = jest.fn().mockResolvedValue(opts.coverage ?? null);
  const createMany = jest.fn().mockResolvedValue({ count: (opts.ohlc ?? []).length });
  const upsert = jest.fn().mockResolvedValue({});
  const client = {
    tokenCandle: { findMany, createMany },
    tokenCandleCoverage: { findUnique, upsert },
  };
  const prisma: any = {
    getReadClient: () => client,
    getWriteClient: () => client,
  };
  const fetchOhlc = jest.fn().mockResolvedValue(opts.ohlc ?? []);
  const provider: any = { fetchOhlc };
  const service = new CandleService(prisma, provider);
  return { service, fetchOhlc, createMany, upsert, findMany };
}

const FROM = new Date('2026-08-01T00:00:00Z');
const TO = new Date('2026-08-05T00:00:00Z');
const MINT = 'MINT111';

describe('CandleService (negative cache)', () => {
  it('candle no banco → serve do banco, NÃO chama o provider', async () => {
    const { service, fetchOhlc } = makeService({
      candles: [{ openTime: FROM, high: '2', close: '1.5' }],
    });
    const res = await service.getCandles(ChainType.SOLANA, Chain.SOLANA, MINT, FROM, TO);
    expect(res).toEqual([{ timeMs: FROM.getTime(), high: 2, close: 1.5 }]);
    expect(fetchOhlc).not.toHaveBeenCalled();
  });

  it('sem candle + janela JÁ coberta (vazia) → [] e NÃO chama o provider', async () => {
    const { service, fetchOhlc } = makeService({
      candles: [],
      coverage: { fromTime: new Date('2026-07-01Z'), toTime: new Date('2026-09-01Z') },
    });
    const res = await service.getCandles(ChainType.SOLANA, Chain.SOLANA, MINT, FROM, TO);
    expect(res).toEqual([]);
    expect(fetchOhlc).not.toHaveBeenCalled(); // negative cache poupou a chamada
  });

  it('sem candle + sem cobertura → chama o provider 1×, persiste e marca cobertura', async () => {
    const { service, fetchOhlc, createMany, upsert } = makeService({
      candles: [],
      coverage: null,
      ohlc: [
        { openTime: FROM, open: '1', high: '3', low: '0.5', close: '2' },
      ],
    });
    const res = await service.getCandles(ChainType.SOLANA, Chain.SOLANA, MINT, FROM, TO);
    expect(fetchOhlc).toHaveBeenCalledTimes(1);
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(1); // cobertura registrada
    expect(res).toEqual([{ timeMs: FROM.getTime(), high: 3, close: 2 }]);
  });

  it('provider volta VAZIO → marca cobertura mesmo assim (não re-consulta depois)', async () => {
    const { service, fetchOhlc, upsert } = makeService({
      candles: [],
      coverage: null,
      ohlc: [],
    });
    const res = await service.getCandles(ChainType.SOLANA, Chain.SOLANA, MINT, FROM, TO);
    expect(res).toEqual([]);
    expect(fetchOhlc).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(1); // marca [from,to] coberta (token morto)
  });

  it('janela pedida MAIS AMPLA que a coberta → cobre o buraco (chama o provider)', async () => {
    const { service, fetchOhlc } = makeService({
      candles: [],
      // cobertura só até 2026-08-03, mas pedimos até 2026-08-05
      coverage: { fromTime: FROM, toTime: new Date('2026-08-03T00:00:00Z') },
      ohlc: [],
    });
    await service.getCandles(ChainType.SOLANA, Chain.SOLANA, MINT, FROM, TO);
    expect(fetchOhlc).toHaveBeenCalledTimes(1);
  });
});
