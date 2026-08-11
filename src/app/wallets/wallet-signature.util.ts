import { verifyMessage } from 'ethers';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { ChainType } from '@prisma/client';

/**
 * Prova de posse de carteira por ASSINATURA (sem conexão persistente). O usuário
 * assina uma mensagem read-only (não autoriza transações) e o backend verifica
 * que a assinatura veio mesmo do endereço.
 */

/** Mensagem canônica que o usuário assina (server-controlled → anti-tamper). */
export function buildVerificationMessage(address: string, nonce: string): string {
  return (
    'Deep Alpha — verificação de carteira\n\n' +
    'Confirmo que sou dono deste endereço. Esta assinatura é gratuita e NÃO ' +
    'autoriza transações:\n' +
    `${address}\n\n` +
    `Nonce: ${nonce}`
  );
}

/**
 * Verifica que `signature` foi produzida por `address` sobre `message`.
 *  - EVM: recuperação ECDSA (EIP-191 / personal_sign) via ethers. `signature` = hex `0x…`.
 *  - SOLANA: Ed25519 via tweetnacl. `address` = pubkey base58; `signature` = base64.
 * Qualquer erro (formato inválido, mismatch) → `false` (nunca lança).
 */
export function verifyWalletSignature(
  chainType: ChainType,
  address: string,
  message: string,
  signature: string,
): boolean {
  try {
    if (chainType === ChainType.EVM) {
      return verifyMessage(message, signature).toLowerCase() === address.toLowerCase();
    }
    // SOLANA
    const pubkey = bs58.decode(address);
    const sig = Buffer.from(signature, 'base64');
    const msg = new TextEncoder().encode(message);
    return nacl.sign.detached.verify(msg, sig, pubkey);
  } catch {
    return false;
  }
}
