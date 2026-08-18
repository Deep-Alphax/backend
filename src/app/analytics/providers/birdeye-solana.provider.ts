import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { TradeSide } from '@prisma/client';
import {
  FetchSwapsParams,
  FetchSwapsResult,
  FetchOhlcParams,
  OhlcCandle,
  ProviderSwap,
  ProviderRequestError,
} from './market-data-provider.interface';

/**
 * Fonte de swaps Solana via Birdeye (`/trader/txs/seek_by_time`, tx_type=swap).
 *
 * POR QUÊ: o Birdeye é um indexador de trades dedicado — devolve os swaps JÁ
 * classificados (buy/sell) e JÁ com USD real no instante do trade (`volume_usd`),
 * cobrindo agregador/bonding-curve/pump.fun. Ganho duplo sobre reconstruir por
 * delta no Helius: (1) performance/custo — pagina SÓ os swaps (poucas páginas) em
 * vez de todas as txs + preço do SOL por página; (2) exatidão — sem aproximação
 * SOL×preço-do-dia nem "trade sem preço".
 *
 * Paginação por OFFSET (sort desc), com o piso `sinceBlockTime` aplicado no
 * cliente (para de paginar ao cruzar a janela). Só ativo com `BIRDEYE_API_KEY`;
 * senão o composite cai no Helius.
 */
@Injectable()
export class BirdeyeSolanaProvider {
  private readonly logger = new Logger(BirdeyeSolanaProvider.name);
  private readonly apiKey: string;
  private readonly base: string;
  /** Espaçamento mínimo entre chamadas (free tier ~1 RPS). */
  private static readonly MIN_INTERVAL_MS = 1100;
  private lastCallAt = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
  ) {
    this.apiKey = this.config.get<string>('BIRDEYE_API_KEY') ?? '';
    this.base =
      this.config.get<string>('BIRDEYE_BASE') ?? 'https://public-api.birdeye.so';
  }

  /** True quando há key configurada (o composite decide Birdeye vs Helius por isto). */
  isEnabled(): boolean {
    return this.apiKey.length > 0;
  }

  async fetchSwaps(params: FetchSwapsParams): Promise<FetchSwapsResult> {
    if (!this.apiKey) {
      throw new ProviderRequestError('BIRDEYE_API_KEY não configurada', 401);
    }
    const limit = Math.min(params.limit ?? 100, 100);
    const offset = params.cursor ? Number(params.cursor) : 0;
    const sinceMs = params.sinceBlockTime
      ? params.sinceBlockTime.getTime()
      : null;

    const items = await this.fetchItems('/trader/txs/seek_by_time', {
      address: params.address,
      offset: String(offset),
      limit: String(limit),
      tx_type: 'swap',
      sort_type: 'desc',
    });

    const swaps: ProviderSwap[] = [];
    let reachedOld = false;
    for (const it of items) {
      const tsMs = (Number(it?.block_unix_time) || 0) * 1000;
      // Piso da janela: sort desc → ao cruzar, para de paginar.
      if (sinceMs != null && tsMs < sinceMs) {
        reachedOld = true;
        break;
      }
      const s = this.map(it, params.address);
      if (s) swaps.push(s);
    }

    this.logger.log(
      `Birdeye Solana ${params.address}: offset=${offset} → ${items.length} txs, ` +
        `${swaps.length} swaps (reachedOld=${reachedOld})`,
    );

    // Continua só se a página veio cheia e não cruzou a fronteira.
    const full = items.length >= limit;
    const nextCursor = full && !reachedOld ? String(offset + limit) : null;
    return { swaps, nextCursor };
  }

  /** Item do Birdeye → ProviderSwap. `null` quando faltam dados essenciais. */
  private map(it: any, owner: string): ProviderSwap | null {
    const base = it?.base;
    const quote = it?.quote;
    if (!base?.address || !quote?.address) return null;

    const baseQty = Math.abs(Number(base.ui_amount) || 0);
    const quoteQty = Math.abs(Number(quote.ui_amount) || 0);
    if (baseQty <= 0) return null;

    // base entrou na carteira (Δ>0) = BUY; saiu (Δ<0) = SELL.
    const side = Number(base.ui_change_amount) > 0 ? TradeSide.BUY : TradeSide.SELL;
    const usd = Number(it?.volume_usd);
    const hasUsd = Number.isFinite(usd) && usd > 0;
    const priceUsd = Number(base.price ?? base.nearest_price);

    return {
      txHash: String(it?.tx_hash ?? ''),
      blockTime: new Date((Number(it?.block_unix_time) || 0) * 1000),
      side,
      baseMint: String(base.address),
      baseSymbol: base.symbol ?? null,
      baseAmount: String(baseQty),
      quoteMint: String(quote.address),
      quoteSymbol: quote.symbol ?? null,
      quoteAmount: String(quoteQty),
      usdValue: hasUsd ? String(usd) : '0',
      priceUsd:
        Number.isFinite(priceUsd) && priceUsd > 0
          ? String(priceUsd)
          : hasUsd
            ? String(usd / baseQty)
            : '0',
      // Birdeye já traz o USD real do trade — sem imputação.
      feeUsd: null,
      feeNative: null,
      priceResolved: hasUsd,
      dexProgram: it?.source ?? null,
      raw: it,
    };
  }

  /**
   * OHLC de um token via Birdeye (`/defi/ohlcv`) — cobre memecoin/bonding-curve,
   * onde a Moralis não tem candle. Best-effort: `[]` em falha (contrato de OHLC).
   */
  async fetchOhlc(params: FetchOhlcParams): Promise<OhlcCandle[]> {
    if (!this.apiKey) return [];
    try {
      const items = await this.fetchItems('/defi/ohlcv', {
        address: params.mint,
        type: params.timeframe === '1d' ? '1D' : '1H',
        time_from: String(Math.floor(params.from.getTime() / 1000)),
        time_to: String(Math.floor(params.to.getTime() / 1000)),
      });
      return items
        .map((it) => ({
          openTime: new Date((Number(it?.unixTime) || 0) * 1000),
          open: String(it?.o ?? ''),
          high: String(it?.h ?? ''),
          low: String(it?.l ?? ''),
          close: String(it?.c ?? ''),
        }))
        .filter((c) => c.openTime.getTime() > 0 && c.close !== '');
    } catch {
      return []; // OHLC é best-effort — cobertura irregular não deve derrubar métricas
    }
  }

  /** GET Birdeye genérico (`data.items`) + throttle + retry de 429 (free tier). */
  private async fetchItems(
    path: string,
    params: Record<string, string>,
  ): Promise<any[]> {
    const url = `${this.base}${path}`;

    for (let attempt = 0; attempt < 5; attempt++) {
      await this.throttle();
      try {
        const resp = await firstValueFrom(
          this.http.get(url, {
            params,
            headers: {
              'X-API-KEY': this.apiKey,
              'x-chain': 'solana',
              accept: 'application/json',
            },
            timeout: 20000,
          } as any),
        );
        const items = resp.data?.data?.items;
        return Array.isArray(items) ? items : [];
      } catch (err: any) {
        const status = err?.response?.status;
        if (status === 429 && attempt < 4) {
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        this.logger.error(
          `Birdeye GET falhou (status=${status}): ${err?.message}`,
        );
        throw new ProviderRequestError(
          `Falha ao consultar o Birdeye (status=${status ?? 'n/a'})`,
          status,
        );
      }
    }
    throw new ProviderRequestError('Birdeye 429 persistente', 429);
  }

  /** Garante MIN_INTERVAL_MS entre chamadas (protege o rate limit da key). */
  private async throttle(): Promise<void> {
    const wait =
      BirdeyeSolanaProvider.MIN_INTERVAL_MS - (Date.now() - this.lastCallAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCallAt = Date.now();
  }
}
