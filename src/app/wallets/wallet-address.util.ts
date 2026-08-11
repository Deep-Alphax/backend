import { getAddress } from 'ethers';
import bs58 from 'bs58';
import { Chain, ChainType } from '@prisma/client';

/**
 * Mapa Chain → família (ChainType). Governa qual validação/normalização de
 * endereço e qual rota de provider usar. Novas chains entram só aqui.
 */
const CHAIN_FAMILY: Record<Chain, ChainType> = {
  [Chain.SOLANA]: ChainType.SOLANA,
  [Chain.ETHEREUM]: ChainType.EVM,
  [Chain.BASE]: ChainType.EVM,
  [Chain.ARBITRUM]: ChainType.EVM,
  [Chain.BSC]: ChainType.EVM,
  [Chain.POLYGON]: ChainType.EVM,
  [Chain.OPTIMISM]: ChainType.EVM,
};

export function chainTypeOf(chain: Chain): ChainType {
  return CHAIN_FAMILY[chain];
}

export interface NormalizedAddress {
  /** Forma canônica de exibição: checksum EVM (0x…) ou base58 Solana (original). */
  address: string;
  /** Forma para dedupe/lookup: lowercase no EVM; idêntica ao address no Solana. */
  addressNorm: string;
  chainType: ChainType;
}

/**
 * Valida e normaliza um endereço para a chain informada. Lança `Error` com
 * mensagem amigável quando inválido (o service converte em BadRequestException).
 *
 *  - EVM: `ethers.getAddress` valida o formato 0x + checksum EIP-55 e devolve a
 *    forma checksummed. addressNorm = lowercase (o mesmo endereço em qualquer
 *    caixa colapsa no mesmo balde).
 *  - SOLANA: base58 que decodifica para EXATAMENTE 32 bytes (chave pública ed25519).
 *    Base58 é case-sensitive → address e addressNorm são idênticos.
 */
export function normalizeWalletAddress(chain: Chain, rawAddress: string): NormalizedAddress {
  const input = (rawAddress ?? '').trim();
  if (!input) throw new Error('Endereço da carteira é obrigatório');

  const chainType = chainTypeOf(chain);

  if (chainType === ChainType.EVM) {
    let checksummed: string;
    try {
      // getAddress aceita minúsculo/maiúsculo; se vier misto, valida o checksum EIP-55.
      checksummed = getAddress(input);
    } catch {
      throw new Error('Endereço EVM inválido (esperado formato 0x com 40 caracteres hex)');
    }
    return { address: checksummed, addressNorm: checksummed.toLowerCase(), chainType };
  }

  // SOLANA
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(input);
  } catch {
    throw new Error('Endereço Solana inválido (base58 malformado)');
  }
  if (bytes.length !== 32) {
    throw new Error('Endereço Solana inválido (deve decodificar para 32 bytes)');
  }
  return { address: input, addressNorm: input, chainType };
}
