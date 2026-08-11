import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { Chain, ChainType, TradeSide } from '@prisma/client';
import { chainTypeOf } from '../../wallets/wallet-address.util';
import {
  MarketDataProvider,
  FetchSwapsParams,
  FetchSwapsResult,
  ProviderSwap,
  FetchOhlcParams,
  OhlcCandle,
  TokenSnapshot,
} from './market-data-provider.interface';

/** Chain → parâmetro `chain` (hex) da API EVM da Moralis. */
const MORALIS_EVM_CHAIN: Partial<Record<Chain, string>> = {
  [Chain.ETHEREUM]: '0x1',
  [Chain.BASE]: '0x2105',
  [Chain.ARBITRUM]: '0xa4b1',
  [Chain.BSC]: '0x38',
  [Chain.POLYGON]: '0x89',
  [Chain.OPTIMISM]: '0xa',
};

/**
 * Adapter Moralis do MarketDataProvider — cobre EVM (Wallet API) e Solana
 * (Solana Gateway) numa única integração.
 *
 * NOTA DE INTEGRAÇÃO: os nomes de campo do JSON da Moralis podem variar entre
 * versões/endpoints. Todo o acesso à resposta está isolado em `mapEvmSwap` /
 * `mapSolanaSwap` — se um campo divergir do esperado, ajusta-se só ali. Precisa
 * ser validado contra uma resposta real (requer MORALIS_API_KEY).
 */
@Injectable()
export class MoralisProvider implements MarketDataProvider {
  private readonly logger = new Logger(MoralisProvider.name);
  private readonly apiKey: string;
  private readonly evmBase: string;
  private readonly solanaBase: string;
  private readonly solanaNetwork: string;
  private readonly solanaRpc: string;

  /** Mint do Wrapped SOL — usado para extrair o preço do SOL de cada swap. */
  private static readonly WSOL = 'So11111111111111111111111111111111111111112';

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
  ) {
    this.apiKey = this.config.get<string>('MORALIS_API_KEY') ?? '';
    this.evmBase =
      this.config.get<string>('MORALIS_EVM_BASE') ?? 'https://deep-index.moralis.io/api/v2.2';
    this.solanaBase =
      this.config.get<string>('MORALIS_SOLANA_BASE') ?? 'https://solana-gateway.moralis.io';
    this.solanaNetwork = this.config.get<string>('MORALIS_SOLANA_NETWORK') ?? 'mainnet';
    // RPC Solana p/ enriquecer a taxa on-chain (meta.fee). O público é rate-limited
    // e NÃO é arquival (txs antigas retornam null) — em prod usar Helius/QuickNode.
    this.solanaRpc =
      this.config.get<string>('SOLANA_RPC_URL') ?? 'https://api.mainnet-beta.solana.com';
  }

  async fetchSwaps(params: FetchSwapsParams): Promise<FetchSwapsResult> {
    if (!this.apiKey) {
      throw new ServiceUnavailableException('MORALIS_API_KEY não configurada');
    }
    return chainTypeOf(params.chain) === ChainType.EVM
      ? this.fetchEvmSwaps(params)
      : this.fetchSolanaSwaps(params);
  }

  // ─────────────────────────── EVM ───────────────────────────

  private async fetchEvmSwaps(params: FetchSwapsParams): Promise<FetchSwapsResult> {
    const chainParam = MORALIS_EVM_CHAIN[params.chain];
    if (!chainParam) throw new ServiceUnavailableException(`Chain EVM não suportada: ${params.chain}`);

    const url = `${this.evmBase}/wallets/${params.address}/swaps`;
    const query: Record<string, string> = {
      chain: chainParam,
      order: 'ASC',
      limit: String(params.limit ?? 100),
    };
    if (params.cursor) query.cursor = params.cursor;
    if (params.sinceBlockTime) query.fromDate = params.sinceBlockTime.toISOString();

    const data = await this.get(url, query);
    const rows: any[] = Array.isArray(data?.result) ? data.result : [];
    const swaps = rows.map((r) => this.mapEvmSwap(r)).filter((s): s is ProviderSwap => s !== null);
    return { swaps, nextCursor: data?.cursor || null };
  }

  // ─────────────────────────── Solana ───────────────────────────

  private async fetchSolanaSwaps(params: FetchSwapsParams): Promise<FetchSwapsResult> {
    const url = `${this.solanaBase}/account/${this.solanaNetwork}/${params.address}/swaps`;
    const query: Record<string, string> = {
      order: 'ASC',
      limit: String(params.limit ?? 100),
    };
    if (params.cursor) query.cursor = params.cursor;
    if (params.sinceBlockTime) query.fromDate = params.sinceBlockTime.toISOString();

    const data = await this.get(url, query);
    const rows: any[] = Array.isArray(data?.result) ? data.result : [];
    const swaps = rows.map((r) => this.mapSolanaSwap(r)).filter((s): s is ProviderSwap => s !== null);
    // Moralis não traz taxa; enriquece com a fee on-chain (meta.fee) via RPC.
    await this.enrichSolanaFees(swaps);
    return { swaps, nextCursor: data?.cursor || null };
  }

  // ─────────────────────────── Taxa on-chain (Solana RPC) ───────────────────────────

  /**
   * Preenche feeNative (SOL) e feeUsd de cada swap com a taxa REAL paga on-chain
   * (base + priority fees), lida de `getTransaction().meta.fee` via RPC em lote.
   * Best-effort: falha de RPC ou tx não-arquival deixa a taxa em 0 (não quebra a sync).
   */
  private async enrichSolanaFees(swaps: ProviderSwap[]): Promise<void> {
    if (!swaps.length) return;
    const feesLamports = await this.fetchSolanaFees(swaps.map((s) => s.txHash));
    let lastSolPrice: number | null = null;
    for (const s of swaps) {
      const lamports = feesLamports.get(s.txHash);
      if (lamports == null) continue;
      const sol = lamports / 1e9;
      s.feeNative = String(sol);
      const solPrice = this.solPriceFromRaw(s.raw) ?? lastSolPrice;
      if (solPrice != null) {
        lastSolPrice = solPrice;
        s.feeUsd = String(sol * solPrice);
      }
    }
  }

  /** Extrai o preço USD do SOL do próprio swap (lado cujo mint é WSOL). */
  private solPriceFromRaw(raw: any): number | null {
    for (const side of [raw?.bought, raw?.sold]) {
      if (side?.address === MoralisProvider.WSOL) {
        const p = Number(side?.usdPrice);
        if (Number.isFinite(p) && p > 0) return p;
      }
    }
    return null;
  }

  /** getTransaction em lote (JSON-RPC batch) → Map<assinatura, lamports de fee>. */
  private async fetchSolanaFees(sigs: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const CHUNK = 25; // lotes pequenos p/ não estourar o rate limit do RPC público
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    for (let i = 0; i < sigs.length; i += CHUNK) {
      const chunk = sigs.slice(i, i + CHUNK);
      const body = chunk.map((sig, idx) => ({
        jsonrpc: '2.0',
        id: idx,
        method: 'getTransaction',
        params: [sig, { maxSupportedTransactionVersion: 0, encoding: 'json' }],
      }));

      // Uma tentativa + 2 retries com backoff em 429/erro (RPC público é agressivo).
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const resp = await firstValueFrom(
            this.http.post(this.solanaRpc, body, {
              headers: { 'Content-Type': 'application/json' },
              timeout: 20000,
            } as any),
          );
          const arr: any[] = Array.isArray(resp?.data) ? resp.data : [];
          for (const item of arr) {
            const fee = item?.result?.meta?.fee;
            const sig = chunk[item?.id];
            if (sig && typeof fee === 'number') out.set(sig, fee);
          }
          break; // sucesso
        } catch (err: any) {
          const status = err?.response?.status;
          if (attempt < 2 && (status === 429 || status >= 500 || !status)) {
            await sleep(400 * (attempt + 1)); // backoff
            continue;
          }
          this.logger.warn(`RPC Solana getTransaction (fee) falhou (status=${status}): ${err?.message}`);
        }
      }
      // Pacing entre lotes p/ ser gentil com o RPC público.
      if (i + CHUNK < sigs.length) await sleep(150);
    }
    return out;
  }

  // ─────────────────────────── OHLC / snapshot (Bloco 2) ───────────────────────────
  //
  // NOTA: como o restante do adapter, os nomes de campo do JSON da Moralis podem
  // variar por endpoint/versão. Todo acesso está isolado nos mapeadores abaixo e
  // é BEST-EFFORT: qualquer falha/ausência vira `[]`/`null` (não quebra métricas).

  async fetchOhlc(params: FetchOhlcParams): Promise<OhlcCandle[]> {
    if (!this.apiKey) return [];
    try {
      return chainTypeOf(params.chain) === ChainType.EVM
        ? await this.fetchEvmOhlc(params)
        : await this.fetchSolanaOhlc(params);
    } catch (err: any) {
      this.logger.warn(`OHLC ${params.mint} (best-effort) falhou: ${err?.message}`);
      return [];
    }
  }

  private async fetchEvmOhlc(params: FetchOhlcParams): Promise<OhlcCandle[]> {
    const chainParam = MORALIS_EVM_CHAIN[params.chain];
    if (!chainParam) return [];
    const pairs = await this.getSafe(`${this.evmBase}/erc20/${params.mint}/pairs`, {
      chain: chainParam,
    });
    const pairAddress = this.bestPairAddress(pairs);
    if (!pairAddress) return [];
    const data = await this.getSafe(`${this.evmBase}/pairs/${pairAddress}/ohlcv`, {
      chain: chainParam,
      timeframe: params.timeframe,
      currency: 'usd',
      fromDate: params.from.toISOString(),
      toDate: params.to.toISOString(),
    });
    return this.mapOhlc(data?.result ?? data);
  }

  private async fetchSolanaOhlc(params: FetchOhlcParams): Promise<OhlcCandle[]> {
    const base = `${this.solanaBase}/token/${this.solanaNetwork}`;
    const pairs = await this.getSafe(`${base}/${params.mint}/pairs`, {});
    const pairAddress = this.bestPairAddress(pairs);
    if (!pairAddress) return [];
    const data = await this.getSafe(`${base}/pairs/${pairAddress}/ohlcv`, {
      timeframe: params.timeframe,
      currency: 'usd',
      fromDate: params.from.toISOString(),
      toDate: params.to.toISOString(),
    });
    return this.mapOhlc(data?.result ?? data);
  }

  async fetchTokenSnapshot(chain: Chain, mint: string): Promise<TokenSnapshot | null> {
    if (!this.apiKey) return null;
    try {
      const url =
        chainTypeOf(chain) === ChainType.EVM
          ? `${this.evmBase}/erc20/${mint}/price`
          : `${this.solanaBase}/token/${this.solanaNetwork}/${mint}/price`;
      const query =
        chainTypeOf(chain) === ChainType.EVM
          ? { chain: MORALIS_EVM_CHAIN[chain] ?? '' }
          : {};
      const data = await this.getSafe(url, query as Record<string, string>);
      if (!data) return null;
      return {
        priceUsd: this.num(data?.usdPrice ?? data?.usdPriceFormatted),
        liquidityUsd: this.num(data?.pairTotalLiquidityUsd ?? data?.liquidityUsd),
      };
    } catch {
      return null;
    }
  }

  /** Escolhe o par mais líquido de uma resposta de "token pairs". */
  private bestPairAddress(data: any): string | null {
    const list: any[] = Array.isArray(data?.pairs)
      ? data.pairs
      : Array.isArray(data?.result)
        ? data.result
        : Array.isArray(data)
          ? data
          : [];
    if (list.length === 0) return null;
    const sorted = [...list].sort(
      (a, b) => Number(b?.liquidityUsd ?? 0) - Number(a?.liquidityUsd ?? 0),
    );
    const p = sorted[0];
    return p?.pairAddress ?? p?.pair_address ?? p?.address ?? null;
  }

  /** Normaliza linhas OHLCV → OhlcCandle[] (defensivo contra variações de campo). */
  private mapOhlc(rows: any): OhlcCandle[] {
    if (!Array.isArray(rows)) return [];
    const out: OhlcCandle[] = [];
    for (const r of rows) {
      const ts = r?.timestamp ?? r?.openTimestamp ?? r?.openTime ?? r?.time;
      const high = this.num(r?.high);
      if (ts == null || high == null) continue;
      out.push({
        openTime: this.parseTime(ts),
        open: this.num(r?.open) ?? '0',
        high,
        low: this.num(r?.low) ?? '0',
        close: this.num(r?.close) ?? '0',
      });
    }
    return out;
  }

  /** ISO string, epoch em segundos ou ms → Date. */
  private parseTime(ts: unknown): Date {
    if (typeof ts === 'number') return new Date(ts < 1e12 ? ts * 1000 : ts);
    const n = Number(ts);
    if (Number.isFinite(n) && String(ts).trim() !== '') {
      return new Date(n < 1e12 ? n * 1000 : n);
    }
    return new Date(String(ts));
  }

  /** GET que NÃO lança (best-effort): erro/ausência → null. */
  private async getSafe(url: string, params: Record<string, string>): Promise<any | null> {
    try {
      const resp = await firstValueFrom(
        this.http.get(url, {
          params,
          headers: { accept: 'application/json', 'X-API-Key': this.apiKey },
          timeout: 15000,
        } as any),
      );
      return resp.data;
    } catch (err: any) {
      this.logger.warn(
        `Moralis GET ${url} (best-effort) falhou (status=${err?.response?.status ?? 'n/a'})`,
      );
      return null;
    }
  }

  // ─────────────────────────── HTTP ───────────────────────────

  private async get(url: string, params: Record<string, string>): Promise<any> {
    try {
      const resp = await firstValueFrom(
        this.http.get(url, {
          params,
          headers: { accept: 'application/json', 'X-API-Key': this.apiKey },
          timeout: 15000,
        } as any),
      );
      return resp.data;
    } catch (err: any) {
      const status = err?.response?.status;
      this.logger.error(`Moralis GET ${url} falhou (status=${status}): ${err?.message}`);
      // 4xx de dados (ex.: endereço inválido) não deve virar retry infinito no worker.
      throw new ServiceUnavailableException(`Falha ao consultar a Moralis (status=${status ?? 'n/a'})`);
    }
  }

  // ─────────────────────────── Mapeadores (pontos de ajuste) ───────────────────────────

  /**
   * Mapeia um swap EVM (Wallet API) → ProviderSwap. Modelo esperado: cada entrada
   * traz `transactionType` (buy/sell) e os lados `bought`/`sold` com
   * {address, symbol, amount, usdPrice, usdAmount}. O BASE é o token negociado
   * (recebido no buy / vendido no sell); o QUOTE é a contraparte.
   */
  private mapEvmSwap(r: any): ProviderSwap | null {
    const type = String(r?.transactionType ?? '').toLowerCase();
    const side: TradeSide | null = type === 'buy' ? TradeSide.BUY : type === 'sell' ? TradeSide.SELL : null;
    const txHash = r?.transactionHash ?? r?.transaction_hash ?? r?.hash;
    const blockTs = r?.blockTimestamp ?? r?.block_timestamp;
    if (!side || !txHash || !blockTs) return null;

    const bought = r?.bought ?? {};
    const sold = r?.sold ?? {};
    // base = ativo negociado; no buy é o que entrou (bought), no sell é o que saiu (sold).
    const base = side === TradeSide.BUY ? bought : sold;
    const quote = side === TradeSide.BUY ? sold : bought;

    const priceUsd = this.num(base?.usdPrice);
    const baseAmount = this.abs(base?.amount);
    const usdValue = this.num(base?.usdAmount) ?? this.num(r?.totalValueUsd) ?? this.mul(baseAmount, priceUsd);

    return {
      txHash: String(txHash),
      blockTime: new Date(blockTs),
      side,
      baseMint: String(base?.address ?? base?.tokenAddress ?? ''),
      baseSymbol: base?.symbol ?? null,
      baseAmount,
      quoteMint: String(quote?.address ?? quote?.tokenAddress ?? ''),
      quoteSymbol: quote?.symbol ?? null,
      quoteAmount: this.abs(quote?.amount),
      usdValue: usdValue ?? '0',
      priceUsd: priceUsd ?? '0',
      feeUsd: this.num(r?.feeUsd) ?? null,
      priceResolved: priceUsd != null && priceUsd !== '0',
      dexProgram: r?.exchangeName ?? r?.pairLabel ?? null,
      raw: r,
    };
  }

  /** Mapeia um swap Solana (Solana Gateway) → ProviderSwap. Mesmo modelo bought/sold. */
  private mapSolanaSwap(r: any): ProviderSwap | null {
    const type = String(r?.transactionType ?? '').toLowerCase();
    const side: TradeSide | null = type === 'buy' ? TradeSide.BUY : type === 'sell' ? TradeSide.SELL : null;
    const txHash = r?.transactionHash ?? r?.signature ?? r?.txHash;
    const blockTs = r?.blockTimestamp ?? r?.blockTime;
    if (!side || !txHash || !blockTs) return null;

    const bought = r?.bought ?? {};
    const sold = r?.sold ?? {};
    const base = side === TradeSide.BUY ? bought : sold;
    const quote = side === TradeSide.BUY ? sold : bought;

    const priceUsd = this.num(base?.usdPrice);
    const baseAmount = this.abs(base?.amount);
    const usdValue = this.num(base?.usdAmount) ?? this.num(r?.totalValueUsd) ?? this.mul(baseAmount, priceUsd);

    return {
      txHash: String(txHash),
      blockTime: new Date(typeof blockTs === 'number' ? blockTs * 1000 : blockTs),
      side,
      baseMint: String(base?.address ?? base?.mint ?? ''),
      baseSymbol: base?.symbol ?? null,
      baseAmount,
      quoteMint: String(quote?.address ?? quote?.mint ?? ''),
      quoteSymbol: quote?.symbol ?? null,
      quoteAmount: this.abs(quote?.amount),
      usdValue: usdValue ?? '0',
      priceUsd: priceUsd ?? '0',
      feeUsd: this.num(r?.feeUsd) ?? null,
      priceResolved: priceUsd != null && priceUsd !== '0',
      dexProgram: r?.exchangeName ?? r?.pairLabel ?? null,
      raw: r,
    };
  }

  // ─────────────────────────── Parsing seguro ───────────────────────────

  /** String numérica válida (>=0 tolerado) ou null. Evita NaN/undefined virarem '0' silencioso. */
  private num(v: unknown): string | null {
    if (v == null) return null;
    const s = String(v).trim();
    if (s === '' || !Number.isFinite(Number(s))) return null;
    return s;
  }

  /** Valor absoluto (o provider pode devolver amount negativo para o lado vendido). */
  private abs(v: unknown): string {
    const s = this.num(v);
    if (s == null) return '0';
    return s.startsWith('-') ? s.slice(1) : s;
  }

  private mul(a: string | null, b: string | null): string | null {
    if (a == null || b == null) return null;
    const n = Number(a) * Number(b);
    return Number.isFinite(n) ? String(n) : null;
  }
}
