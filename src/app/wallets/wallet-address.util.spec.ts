import { Chain, ChainType } from '@prisma/client';
import { chainTypeOf, normalizeWalletAddress } from './wallet-address.util';

describe('wallet-address.util', () => {
  describe('chainTypeOf', () => {
    it('mapeia Solana → SOLANA', () => {
      expect(chainTypeOf(Chain.SOLANA)).toBe(ChainType.SOLANA);
    });

    it('mapeia todas as chains EVM → EVM', () => {
      for (const c of [Chain.ETHEREUM, Chain.BASE, Chain.ARBITRUM, Chain.BSC, Chain.POLYGON, Chain.OPTIMISM]) {
        expect(chainTypeOf(c)).toBe(ChainType.EVM);
      }
    });
  });

  describe('normalizeWalletAddress — EVM', () => {
    // Endereço EVM canônico (Vitalik) para checagem de checksum.
    const lower = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';
    const checksummed = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

    it('aceita minúsculo e devolve checksum EIP-55; addressNorm em lowercase', () => {
      const r = normalizeWalletAddress(Chain.ETHEREUM, lower);
      expect(r.address).toBe(checksummed);
      expect(r.addressNorm).toBe(lower);
      expect(r.chainType).toBe(ChainType.EVM);
    });

    it('normaliza a mesma carteira em qualquer caixa para o mesmo addressNorm', () => {
      const a = normalizeWalletAddress(Chain.BASE, lower);
      const b = normalizeWalletAddress(Chain.BASE, checksummed);
      expect(a.addressNorm).toBe(b.addressNorm);
    });

    it('rejeita endereço com checksum EIP-55 inválido (caixa mista inconsistente)', () => {
      const mixedInvalid = '0xD8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
      expect(() => normalizeWalletAddress(Chain.ETHEREUM, mixedInvalid)).toThrow();
    });

    it('aceita endereço todo em maiúsculas (sem checksum a validar)', () => {
      const r = normalizeWalletAddress(Chain.ETHEREUM, lower.toUpperCase().replace('0X', '0x'));
      expect(r.addressNorm).toBe(lower);
    });

    it('rejeita comprimento/hex inválido', () => {
      expect(() => normalizeWalletAddress(Chain.ETHEREUM, '0x123')).toThrow(/EVM/);
      expect(() => normalizeWalletAddress(Chain.ETHEREUM, 'not-an-address')).toThrow();
    });

    it('rejeita vazio', () => {
      expect(() => normalizeWalletAddress(Chain.ETHEREUM, '   ')).toThrow(/obrigatório/);
    });
  });

  describe('normalizeWalletAddress — Solana', () => {
    // System Program (11111111111111111111111111111111) decodifica p/ 32 bytes.
    const solAddr = 'So11111111111111111111111111111111111111112'; // Wrapped SOL mint (32 bytes)

    it('aceita base58 de 32 bytes; address = addressNorm (case-sensitive)', () => {
      const r = normalizeWalletAddress(Chain.SOLANA, solAddr);
      expect(r.address).toBe(solAddr);
      expect(r.addressNorm).toBe(solAddr);
      expect(r.chainType).toBe(ChainType.SOLANA);
    });

    it('rejeita base58 malformado (caractere inválido 0/O/I/l)', () => {
      expect(() => normalizeWalletAddress(Chain.SOLANA, '0OIl000')).toThrow(/Solana/);
    });

    it('rejeita quando não decodifica para 32 bytes', () => {
      expect(() => normalizeWalletAddress(Chain.SOLANA, 'abc')).toThrow(/32 bytes/);
    });
  });
});
