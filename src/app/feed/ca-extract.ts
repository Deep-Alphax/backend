import { ChainType } from '@prisma/client';

/**
 * Extração PURA de "calls" (CA/mint e ticker) do texto/links de uma mensagem do
 * Discord — insumo do cruzamento trade × call. Sem I/O → testável por caminho
 * relativo. Extração é DELIBERADAMENTE tolerante (pode capturar falsos-positivos):
 * a atribuição só casa esses candidatos contra os mints/tickers REALMENTE negociados
 * pelo usuário, então ruído aqui é inofensivo.
 */

const EVM_RE = /0x[a-fA-F0-9]{40}/g;
const SOL_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
// Ticker: '$' seguido de letra + 1-14 alfanum (evita casar preços tipo $100).
const TICKER_RE = /\$([A-Za-z][A-Za-z0-9]{1,14})/g;

const MAX_MINTS = 25;
const MAX_TICKERS = 25;

/** Normaliza o mint para casar: lowercase no EVM (case-insensitive); Solana como está. */
export function normMint(chainType: ChainType, mint: string): string {
  return chainType === ChainType.EVM ? mint.toLowerCase() : mint;
}

export interface ExtractedCalls {
  mints: { chainType: ChainType; mint: string }[]; // já normalizados
  tickers: string[]; // MAIÚSCULO, sem '$'
}

/** Extrai CAs (EVM 0x… / Solana base58) e tickers ($X) do texto + links. */
export function extractCalls(
  text: string,
  links: string[] = [],
): ExtractedCalls {
  const hay = [text ?? '', ...(links ?? [])].join('\n');

  const byKey = new Map<string, { chainType: ChainType; mint: string }>();
  for (const m of hay.matchAll(EVM_RE)) {
    const mint = m[0].toLowerCase();
    byKey.set(`EVM|${mint}`, { chainType: ChainType.EVM, mint });
  }
  // Tira os CAs EVM antes de varrer base58 (o hex sem 0x poderia re-casar).
  const solHay = hay.replace(EVM_RE, ' ');
  for (const m of solHay.matchAll(SOL_RE)) {
    byKey.set(`SOLANA|${m[0]}`, { chainType: ChainType.SOLANA, mint: m[0] });
  }

  const tickers = new Set<string>();
  for (const m of hay.matchAll(TICKER_RE)) tickers.add(m[1].toUpperCase());

  return {
    mints: [...byKey.values()].slice(0, MAX_MINTS),
    tickers: [...tickers].slice(0, MAX_TICKERS),
  };
}
