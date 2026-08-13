import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { Chain, TradeSide } from '@prisma/client';
import { CacheRedisService } from '../../../common/services/cache-redis.service';
import { MoralisProvider } from './moralis.provider';
import {
  FetchSwapsParams,
  FetchSwapsResult,
  ProviderSwap,
  ProviderRequestError,
  TokenSnapshot,
} from './market-data-provider.interface';

/**
 * Fonte de swaps Solana baseada na Enhanced Transactions API do Helius.
 *
 * POR QUÊ: a Moralis (Solana Gateway) NÃO indexa trades roteadas por agregadores
 * como a Axiom (programa FLASHX) nem pools Meteora DLMM / bonding curve pump.fun —
 * devolve `/swaps` vazio para essas carteiras. O Helius não classifica essas txs
 * como "SWAP" tampouco, MAS entrega os `tokenTransfers`/`nativeTransfers` reais de
 * cada transação. Reconstruímos o swap a partir do MOVIMENTO LÍQUIDO de tokens da
 * carteira — abordagem agnóstica de programa: cobre Axiom/Meteora/pump/Raydium/etc.
 *
 * PREÇO USD: o Helius não traz preço. A perna quote é SOL (WSOL) na esmagadora
 * maioria dos trades de memecoin; derivamos `usdValue` = SOL × preço do SOL no dia
 * (histórico diário via CoinGecko, cacheado por dia). Quote em stablecoin vira valor
 * direto. Sem preço do dia → `priceResolved=false` (alimenta o campo de confiança).
 *
 * SEM MORALIS: preço do SOL (histórico via CoinGecko, atual via DexScreener), saldo
 * e snapshots de token (via DexScreener) — tudo em fontes grátis e sem key. A Moralis
 * fica reservada só ao que ela é indispensável (swaps/net-worth EVM).
 */
@Injectable()
export class HeliusSolanaProvider {
  private readonly logger = new Logger(HeliusSolanaProvider.name);
  private readonly apiKey: string;
  private readonly base: string;

  /** Wrapped SOL — perna quote padrão dos swaps de memecoin. */
  private static readonly WSOL = 'So11111111111111111111111111111111111111112';
  /** Stablecoins tratadas como quote com valor USD direto. */
  private static readonly STABLES = new Set<string>([
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  ]);
  /** TTL (s) do cache do mapa preço-do-SOL-por-dia (fechamento diário é imutável). */
  private static readonly SOLUSD_TTL = 24 * 60 * 60;

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
    // Reuso da Moralis SÓ para preço histórico do SOL (OHLC diário do WSOL). Sem ciclo:
    // a Moralis não depende do Helius.
    private readonly moralis: MoralisProvider,
    @Optional() private readonly cache?: CacheRedisService,
  ) {
    this.apiKey = this.config.get<string>('HELIUS_API_KEY') ?? '';
    this.base =
      this.config.get<string>('HELIUS_BASE') ?? 'https://api.helius.xyz';
  }

  async fetchSwaps(params: FetchSwapsParams): Promise<FetchSwapsResult> {
    if (!this.apiKey) {
      throw new ProviderRequestError('HELIUS_API_KEY não configurada', 401);
    }

    const url = `${this.base}/v0/addresses/${params.address}/transactions`;
    const limit = params.limit ?? 100;
    const query: Record<string, string> = {
      'api-key': this.apiKey,
      limit: String(limit),
    };
    if (params.cursor) query.before = params.cursor; // Helius pagina por assinatura

    const txs = await this.get(url, query);
    const rows: any[] = Array.isArray(txs) ? txs : [];

    const sinceMs = params.sinceBlockTime
      ? params.sinceBlockTime.getTime()
      : null;
    const swaps: ProviderSwap[] = [];
    let reachedOld = false;
    let lastSig: string | null = null;

    for (const t of rows) {
      lastSig = t?.signature ?? lastSig;
      const tsMs = (Number(t?.timestamp) || 0) * 1000;
      // Incremental: para de considerar o que é anterior ao último sync.
      if (sinceMs != null && tsMs < sinceMs) {
        reachedOld = true;
        continue;
      }
      const s = this.reconstruct(t, params.address);
      if (s) swaps.push(s);
    }

    await this.priceInUsd(swaps);

    this.logger.log(
      `Helius Solana ${params.address}: ${rows.length} txs → ${swaps.length} swaps reconstruídos` +
        ` (before=${params.cursor ? 'sim' : 'não'})`,
    );

    // Continua paginando só se a página veio cheia e não cruzamos a fronteira incremental.
    const full = rows.length >= limit;
    const nextCursor = full && !reachedOld ? lastSig : null;
    return { swaps, nextCursor };
  }

  // ─────────────────────────── Reconstrução do swap ───────────────────────────

  /**
   * Deriva um swap do delta líquido de tokens da carteira na transação. Regras:
   *  - quote = WSOL ou stablecoin movida pela carteira; base = outro token de maior |Δ|;
   *  - sem perna WSOL/stable nos tokens → usa o SOL nativo líquido como quote;
   *  - side: recebeu base (Δ>0) = BUY; entregou base (Δ<0) = SELL;
   *  - fee = fee da tx se a carteira for o feePayer.
   * Retorna null quando a tx não é um swap (transfer simples, mint/burn, etc.).
   */
  private reconstruct(t: any, address: string): ProviderSwap | null {
    const net = new Map<string, number>();
    for (const tt of t?.tokenTransfers ?? []) {
      const amt = Number(tt?.tokenAmount);
      if (!Number.isFinite(amt) || amt === 0) continue;
      if (tt.fromUserAccount === address)
        net.set(tt.mint, (net.get(tt.mint) ?? 0) - amt);
      if (tt.toUserAccount === address)
        net.set(tt.mint, (net.get(tt.mint) ?? 0) + amt);
    }

    // base = token não-quote com maior movimento absoluto.
    let baseMint: string | null = null;
    let baseAbs = 0;
    for (const [m, d] of net) {
      if (
        m === HeliusSolanaProvider.WSOL ||
        HeliusSolanaProvider.STABLES.has(m)
      )
        continue;
      if (Math.abs(d) > baseAbs) {
        baseAbs = Math.abs(d);
        baseMint = m;
      }
    }
    if (!baseMint || baseAbs < 1e-12) return null;

    // quote: WSOL/stable presente nos tokenTransfers; senão, SOL nativo líquido.
    let quoteMint: string | null = null;
    for (const m of net.keys()) {
      if (
        m === HeliusSolanaProvider.WSOL ||
        HeliusSolanaProvider.STABLES.has(m)
      ) {
        quoteMint = m;
        break;
      }
    }
    let quoteAmount = quoteMint ? Math.abs(net.get(quoteMint) ?? 0) : 0;
    if (!quoteMint) {
      let sol = 0;
      for (const n of t?.nativeTransfers ?? []) {
        const a = (Number(n?.amount) || 0) / 1e9;
        if (n.fromUserAccount === address) sol -= a;
        if (n.toUserAccount === address) sol += a;
      }
      if (Math.abs(sol) > 1e-9) {
        quoteMint = HeliusSolanaProvider.WSOL;
        quoteAmount = Math.abs(sol);
      }
    }
    if (!quoteMint || quoteAmount < 1e-12) return null;

    const baseDelta = net.get(baseMint) ?? 0;
    const side = baseDelta > 0 ? TradeSide.BUY : TradeSide.SELL;
    const feeNative = t?.feePayer === address ? (Number(t?.fee) || 0) / 1e9 : 0;

    return {
      txHash: String(t?.signature ?? ''),
      blockTime: new Date((Number(t?.timestamp) || 0) * 1000),
      side,
      baseMint,
      baseSymbol: null, // Helius não traz símbolo aqui (enriquecível depois via token-metadata)
      baseAmount: String(baseAbs),
      quoteMint,
      quoteSymbol: quoteMint === HeliusSolanaProvider.WSOL ? 'SOL' : null,
      quoteAmount: String(quoteAmount),
      usdValue: '0', // preenchido em priceInUsd
      priceUsd: '0',
      feeNative: String(feeNative),
      feeUsd: null,
      priceResolved: false,
      dexProgram: t?.source ?? null,
      raw: t,
    };
  }

  // ─────────────────── Saldo atual (RPC + DexScreener, SEM Moralis) ───────────────────

  /** Programas de token SPL (clássico + Token-2022) para listar os holdings. */
  private static readonly TOKEN_PROGRAM =
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  private static readonly TOKEN_2022 =
    'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

  /** URL RPC: Helius (com key) se houver; senão o SOLANA_RPC_URL público. */
  private rpcUrl(): string {
    return this.apiKey
      ? `https://mainnet.helius-rpc.com/?api-key=${this.apiKey}`
      : (this.config.get<string>('SOLANA_RPC_URL') ??
          'https://api.mainnet-beta.solana.com');
  }

  private async rpcCall(method: string, params: unknown[]): Promise<any> {
    const resp = await firstValueFrom(
      this.http.post(this.rpcUrl(), { jsonrpc: '2.0', id: 1, method, params }, {
        timeout: 15000,
      } as any),
    );
    return resp.data?.result;
  }

  /**
   * Saldo ATUAL em USD SEM Moralis: holdings via RPC (getBalance +
   * getTokenAccountsByOwner, SPL clássico + Token-2022) × preço via DexScreener
   * (grátis, sem key). Best-effort → null em falha.
   */
  async fetchWalletBalanceUsd(
    _chain: Chain,
    address: string,
  ): Promise<string | null> {
    try {
      const [bal, spl, spl22] = await Promise.all([
        this.rpcCall('getBalance', [address]),
        this.rpcCall('getTokenAccountsByOwner', [
          address,
          { programId: HeliusSolanaProvider.TOKEN_PROGRAM },
          { encoding: 'jsonParsed' },
        ]),
        this.rpcCall('getTokenAccountsByOwner', [
          address,
          { programId: HeliusSolanaProvider.TOKEN_2022 },
          { encoding: 'jsonParsed' },
        ]),
      ]);

      const solAmount = Number(bal?.value ?? 0) / 1e9;
      const holdings = new Map<string, number>();
      for (const acc of [...(spl?.value ?? []), ...(spl22?.value ?? [])]) {
        const info = acc?.account?.data?.parsed?.info;
        const mint = info?.mint;
        const amt = Number(info?.tokenAmount?.uiAmount ?? 0);
        if (mint && amt > 0)
          holdings.set(mint, (holdings.get(mint) ?? 0) + amt);
      }

      const prices = await this.dexScreenerPrices([
        HeliusSolanaProvider.WSOL,
        ...holdings.keys(),
      ]);
      let total = solAmount * (prices.get(HeliusSolanaProvider.WSOL) ?? 0);
      for (const [mint, amt] of holdings)
        total += amt * (prices.get(mint) ?? 0);

      return Number.isFinite(total) ? total.toFixed(2) : null;
    } catch (err: any) {
      this.logger.warn(
        `Balanço Solana (RPC/DexScreener) falhou (${address}): ${err?.message}`,
      );
      return null;
    }
  }

  /** Preço USD por mint via DexScreener (lotes de 30). Usa o par de MAIOR liquidez. */
  private async dexScreenerPrices(
    mints: string[],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const bestLiq = new Map<string, number>();
    const uniq = [...new Set(mints)].slice(0, 300);
    for (let i = 0; i < uniq.length; i += 30) {
      const chunk = uniq.slice(i, i + 30);
      try {
        const resp = await firstValueFrom(
          this.http.get(
            `https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`,
            { timeout: 12000 } as any,
          ),
        );
        const pairs: any[] = resp.data?.pairs ?? [];
        for (const p of pairs) {
          const mint = p?.baseToken?.address;
          const price = Number(p?.priceUsd);
          const liq = Number(p?.liquidity?.usd ?? 0);
          if (!mint || !Number.isFinite(price) || price <= 0) continue;
          if (liq > (bestLiq.get(mint) ?? -1)) {
            bestLiq.set(mint, liq);
            out.set(mint, price);
          }
        }
      } catch {
        /* lote falhou → mints ficam sem preço (0) */
      }
    }
    return out;
  }

  // ─────────────────────────── Preço USD (perna SOL × preço do SOL no dia) ───────────────────────────

  private async priceInUsd(swaps: ProviderSwap[]): Promise<void> {
    if (!swaps.length) return;

    // Quote em stablecoin → valor USD direto.
    for (const s of swaps) {
      if (HeliusSolanaProvider.STABLES.has(s.quoteMint)) {
        const usd = Number(s.quoteAmount);
        const base = Number(s.baseAmount);
        if (Number.isFinite(usd) && base > 0) {
          s.usdValue = String(usd);
          s.priceUsd = String(usd / base);
          s.priceResolved = true;
        }
      }
    }

    const solQuoted = swaps.filter(
      (s) => s.quoteMint === HeliusSolanaProvider.WSOL,
    );
    if (!solQuoted.length) return;

    const times = solQuoted.map((s) => s.blockTime.getTime());
    const from = new Date(Math.min(...times) - 86_400_000);
    const to = new Date(Math.max(...times) + 86_400_000);
    const byDay = await this.solUsdByDay(from, to);
    // Fallback: se não houver série diária, usa o preço atual do SOL (aproximação).
    const current = byDay.size === 0 ? await this.currentSolUsd() : null;

    for (const s of solQuoted) {
      const day = s.blockTime.toISOString().slice(0, 10);
      const price = byDay.get(day) ?? current;
      if (price == null || !(price > 0)) continue; // fica priceResolved=false, usdValue=0
      const sol = Number(s.quoteAmount);
      const base = Number(s.baseAmount);
      if (!(base > 0)) continue;
      const usd = sol * price;
      s.usdValue = String(usd);
      s.priceUsd = String(usd / base);
      s.feeUsd = s.feeNative ? String(Number(s.feeNative) * price) : null;
      s.priceResolved = true;
    }
  }

  /**
   * Preço do SOL (USD) por dia (YYYY-MM-DD). Cache POR DIA no Redis: o fechamento
   * diário é imutável, então dias já vistos (por outras páginas/carteiras) NÃO
   * refazem chamada. Só bate na Moralis (OHLC diário do WSOL) para os dias que
   * faltam, num único intervalo contíguo — corta drasticamente o custo no backfill.
   */
  private async solUsdByDay(
    from: Date,
    to: Date,
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const days = this.enumerateDays(from, to);
    if (days.length === 0) return out;

    // 1) tenta o cache por dia.
    const missing: string[] = [];
    for (const day of days) {
      const cached = this.cache
        ? await this.cache.getJson<number>(this.solDayKey(day))
        : null;
      if (cached != null && cached > 0) out.set(day, cached);
      else missing.push(day);
    }
    if (missing.length === 0) return out;

    // 2) busca na Moralis SÓ o intervalo faltante (uma vez) e cacheia cada dia.
    const mFrom = new Date(`${missing[0]}T00:00:00Z`);
    const mTo = new Date(`${missing[missing.length - 1]}T23:59:59Z`);
    try {
      const candles = await this.moralis.fetchOhlc({
        chain: Chain.SOLANA,
        mint: HeliusSolanaProvider.WSOL,
        from: mFrom,
        to: mTo,
        timeframe: '1d',
      });
      for (const c of candles) {
        const day = c.openTime.toISOString().slice(0, 10);
        const close = Number(c.close);
        if (close > 0) {
          out.set(day, close);
          await this.cache?.setJson(
            this.solDayKey(day),
            close,
            HeliusSolanaProvider.SOLUSD_TTL,
          );
        }
      }
    } catch (err: any) {
      this.logger.warn(`Preço SOL/dia (WSOL OHLC) falhou: ${err?.message}`);
    }
    return out;
  }

  private solDayKey(day: string): string {
    return `helius:solusd:d:${day}`;
  }

  /** Lista de dias (YYYY-MM-DD, UTC) no intervalo [from, to], inclusive. Bounded. */
  private enumerateDays(from: Date, to: Date): string[] {
    const days: string[] = [];
    const start = Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth(),
      from.getUTCDate(),
    );
    const end = Date.UTC(
      to.getUTCFullYear(),
      to.getUTCMonth(),
      to.getUTCDate(),
    );
    for (let t = start; t <= end; t += 86_400_000) {
      days.push(new Date(t).toISOString().slice(0, 10));
    }
    return days;
  }

  private async currentSolUsd(): Promise<number | null> {
    try {
      const snap = await this.moralis.fetchTokenSnapshot(
        Chain.SOLANA,
        HeliusSolanaProvider.WSOL,
      );
      const p = snap?.priceUsd != null ? Number(snap.priceUsd) : NaN;
      return Number.isFinite(p) && p > 0 ? p : null;
    } catch {
      return null;
    }
  }

  // ─────────────────────────── HTTP ───────────────────────────

  private async get(url: string, params: Record<string, string>): Promise<any> {
    try {
      const resp = await firstValueFrom(
        this.http.get(url, {
          params,
          headers: { accept: 'application/json' },
          timeout: 20000,
        } as any),
      );
      return resp.data;
    } catch (err: any) {
      const status = err?.response?.status;
      this.logger.error(
        `Helius GET ${url} falhou (status=${status}): ${err?.message}`,
      );
      // Propaga o status p/ a ingestão classificar retry (transitório) vs desistir.
      throw new ProviderRequestError(
        `Falha ao consultar o Helius (status=${status ?? 'n/a'})`,
        status,
      );
    }
  }
}
