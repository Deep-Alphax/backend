import { Chain, TradeSide } from '@prisma/client';

/** Token DI da implementação de provider de dados de mercado. */
export const MARKET_DATA_PROVIDER = Symbol('MARKET_DATA_PROVIDER');

/**
 * Erro de requisição a um provider, carregando o HTTP `status` para permitir que
 * o consumidor (ingestão) classifique a falha: transitória (401/429/5xx/timeout →
 * vale retentar com backoff) vs permanente (400/404/422 de dado → não insistir).
 * `status` ausente = erro de rede/timeout (tratado como transitório).
 */
export class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderRequestError';
  }
}

/**
 * Swap normalizado, agnóstico de provider e de chain. Valores monetários e de
 * quantidade viajam como STRING decimal (nunca number) — o persistidor converte
 * para Prisma.Decimal, sem perda de precisão.
 *
 * `side` é do ponto de vista da carteira sobre o token BASE (o ativo negociado):
 *   - BUY: a carteira recebeu `base` e pagou em `quote`.
 *   - SELL: a carteira vendeu `base` e recebeu `quote`.
 */
export interface ProviderSwap {
  txHash: string;
  blockTime: Date; // UTC
  side: TradeSide;

  baseMint: string;
  baseSymbol?: string | null;
  baseAmount: string; // qtd absoluta do token base

  quoteMint: string;
  quoteSymbol?: string | null;
  quoteAmount: string; // qtd absoluta do quote

  usdValue: string; // notional do trade em USD
  priceUsd: string; // USD por 1 unidade de base
  feeUsd?: string | null;
  feeNative?: string | null;

  // false quando o preço USD foi imputado/estimado (não veio direto do provider).
  // Alimenta o campo de confiança/precisão dos agregados.
  priceResolved?: boolean;

  dexProgram?: string | null;
  raw?: unknown; // payload cru do provider (auditoria/reprocessamento)
}

export interface FetchSwapsParams {
  chain: Chain;
  address: string;
  /** Cursor de paginação do provider (ingestão incremental). */
  cursor?: string | null;
  /** Só swaps a partir deste instante (sync incremental — janela desde lastSyncedAt). */
  sinceBlockTime?: Date | null;
  /** Tamanho da página (o provider pode limitar). */
  limit?: number;
}

export interface FetchSwapsResult {
  swaps: ProviderSwap[];
  /** null quando não há mais páginas. */
  nextCursor: string | null;
}

/** Timeframe dos candles OHLC. */
export type OhlcTimeframe = '1h' | '1d';

export interface FetchOhlcParams {
  chain: Chain;
  /** Mint/endereço do token base. */
  mint: string;
  from: Date;
  to: Date;
  timeframe: OhlcTimeframe;
}

/** Vela OHLC normalizada. Valores como STRING decimal (precisão preservada). */
export interface OhlcCandle {
  openTime: Date; // início do bucket (UTC)
  open: string;
  high: string;
  low: string;
  close: string;
}

/** Situação atual de um token (para a métrica de sobrevida). */
export interface TokenSnapshot {
  priceUsd: string | null;
  liquidityUsd: string | null;
}

/**
 * Contrato de um provider de dados on-chain. Qualquer indexador gerenciado
 * (Moralis, Alchemy, Helius/Birdeye…) é plugável desde que implemente isto.
 */
export interface MarketDataProvider {
  /** Página o histórico de swaps de uma carteira, já normalizado. */
  fetchSwaps(params: FetchSwapsParams): Promise<FetchSwapsResult>;

  /**
   * Candles OHLC de um token na janela [from, to]. Best-effort: cobertura de
   * memecoin é irregular — retorna `[]` quando não há dado (não lança).
   */
  fetchOhlc(params: FetchOhlcParams): Promise<OhlcCandle[]>;

  /** Preço/liquidez ATUAIS de um token; `null` quando indisponível (token "morto"). */
  fetchTokenSnapshot(chain: Chain, mint: string): Promise<TokenSnapshot | null>;

  /**
   * Preço/liquidez ATUAIS de VÁRIOS tokens de uma MESMA chain, em LOTE.
   * Deve custar muito menos que N chamadas single (endpoint batch + cache):
   * é o caminho preferido para métricas como sobrevida. Best-effort: mint
   * ausente/indisponível → `null` no Map. Todo mint pedido está presente no Map.
   */
  fetchTokenSnapshots(
    chain: Chain,
    mints: string[],
  ): Promise<Map<string, TokenSnapshot | null>>;
}
