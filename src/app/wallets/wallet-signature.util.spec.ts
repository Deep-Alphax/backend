import { Wallet } from 'ethers';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {
  buildVerificationMessage,
  verifyWalletSignature,
} from './wallet-signature.util';

const MESSAGE = buildVerificationMessage('addr', 'nonce-123');

describe('verifyWalletSignature', () => {
  describe('EVM', () => {
    it('aceita a assinatura correta do dono do endereço', async () => {
      const wallet = Wallet.createRandom();
      const signature = await wallet.signMessage(MESSAGE);
      expect(verifyWalletSignature('EVM', wallet.address, MESSAGE, signature)).toBe(true);
    });

    it('rejeita quando o endereço não bate com quem assinou', async () => {
      const signer = Wallet.createRandom();
      const other = Wallet.createRandom();
      const signature = await signer.signMessage(MESSAGE);
      expect(verifyWalletSignature('EVM', other.address, MESSAGE, signature)).toBe(false);
    });

    it('rejeita quando a mensagem assinada é diferente', async () => {
      const wallet = Wallet.createRandom();
      const signature = await wallet.signMessage(MESSAGE);
      expect(verifyWalletSignature('EVM', wallet.address, MESSAGE + ' x', signature)).toBe(false);
    });

    it('rejeita assinatura malformada sem lançar', () => {
      const wallet = Wallet.createRandom();
      expect(verifyWalletSignature('EVM', wallet.address, MESSAGE, '0xnotasig')).toBe(false);
    });
  });

  describe('SOLANA', () => {
    const sign = (secretKey: Uint8Array, msg: string) =>
      Buffer.from(nacl.sign.detached(new TextEncoder().encode(msg), secretKey)).toString('base64');

    it('aceita a assinatura Ed25519 correta (signature base64, address base58)', () => {
      const kp = nacl.sign.keyPair();
      const address = bs58.encode(kp.publicKey);
      const signature = sign(kp.secretKey, MESSAGE);
      expect(verifyWalletSignature('SOLANA', address, MESSAGE, signature)).toBe(true);
    });

    it('rejeita quando outro par de chaves assinou', () => {
      const signer = nacl.sign.keyPair();
      const victim = nacl.sign.keyPair();
      const signature = sign(signer.secretKey, MESSAGE);
      expect(verifyWalletSignature('SOLANA', bs58.encode(victim.publicKey), MESSAGE, signature)).toBe(false);
    });

    it('rejeita quando a mensagem foi adulterada', () => {
      const kp = nacl.sign.keyPair();
      const signature = sign(kp.secretKey, MESSAGE);
      expect(verifyWalletSignature('SOLANA', bs58.encode(kp.publicKey), MESSAGE + '!', signature)).toBe(false);
    });

    it('rejeita assinatura malformada sem lançar', () => {
      const kp = nacl.sign.keyPair();
      expect(verifyWalletSignature('SOLANA', bs58.encode(kp.publicKey), MESSAGE, 'não-base64-válido')).toBe(false);
    });
  });
});
