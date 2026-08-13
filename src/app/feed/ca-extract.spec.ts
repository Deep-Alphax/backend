import { ChainType } from '@prisma/client';
import { extractCalls, normMint } from './ca-extract';

describe('ca-extract', () => {
  it('extrai CA EVM (0x…40hex) normalizado em lowercase', () => {
    const ca = '0xAbC0000000000000000000000000000000000123';
    const { mints } = extractCalls(`compra ${ca} agora`);
    expect(mints).toContainEqual({
      chainType: ChainType.EVM,
      mint: ca.toLowerCase(),
    });
  });

  it('extrai mint Solana (base58 32-44)', () => {
    const mint = '4y96HLdkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const { mints } = extractCalls(`call ${mint}`);
    expect(mints).toContainEqual({ chainType: ChainType.SOLANA, mint });
  });

  it('extrai mint de dentro de um link (pump.fun)', () => {
    const mint = '5abc6789ABCDEFGHJKLMNPQRSTUVWXYZabcdefgh';
    const { mints } = extractCalls('novo token', [`https://pump.fun/${mint}`]);
    expect(
      mints.some((m) => m.mint === mint && m.chainType === ChainType.SOLANA),
    ).toBe(true);
  });

  it('extrai tickers ($X) em maiúsculo e não casa preço ($100)', () => {
    const { tickers } = extractCalls('comprei $pepe e $SOL por $100');
    expect(tickers).toEqual(expect.arrayContaining(['PEPE', 'SOL']));
    expect(tickers).not.toContain('100');
  });

  it('dedup: mesmo CA repetido conta uma vez', () => {
    const ca = '0x1111111111111111111111111111111111111111';
    const { mints } = extractCalls(`${ca} ... ${ca}`);
    expect(mints.filter((m) => m.mint === ca)).toHaveLength(1);
  });

  it('texto sem CA/ticker → vazio', () => {
    const { mints, tickers } = extractCalls('mensagem qualquer sem nada');
    expect(mints).toEqual([]);
    expect(tickers).toEqual([]);
  });

  it('normMint: EVM lowercase, Solana intacto', () => {
    expect(normMint(ChainType.EVM, '0xAbC')).toBe('0xabc');
    expect(normMint(ChainType.SOLANA, 'AbC1')).toBe('AbC1');
  });
});
