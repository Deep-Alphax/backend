import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { Chain, TradeSide } from '@prisma/client';
import { CacheRedisService } from '../../../common/services/cache-redis.service';
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
  /**
   * TTL (s) do snapshot de token resolvido. Além de survival, o PREÇO alimenta o PnL
   * NÃO-REALIZADO (valor das posições em carteira) — que precisa ser fresco. Mantido
   * ABAIXO do TTL do cache de extras (30min) para que cada recomputo pegue preço novo.
   * DexScreener é keyless (custo zero), então frescor sai de graça.
   */
  private static readonly SNAP_TTL_OK = 5 * 60;
  /** TTL (s) do snapshot NÃO resolvido — curto, p/ auto-recuperar de falha transitória. */
  private static readonly SNAP_TTL_MISS = 15 * 60;

  private readonly coinGeckoBase: string;
  private readonly coinGeckoKey: string;

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
    @Optional() private readonly cache?: CacheRedisService,
  ) {
    this.apiKey = this.config.get<string>('HELIUS_API_KEY') ?? '';
    this.base =
      this.config.get<string>('HELIUS_BASE') ?? 'https://api.helius.xyz';
    this.coinGeckoBase =
      this.config.get<string>('COINGECKO_BASE') ??
      'https://api.coingecko.com/api/v3';
    // Opcional: key demo do CoinGecko (header x-cg-demo-api-key) sobe o rate limit.
    this.coinGeckoKey = this.config.get<string>('COINGECKO_API_KEY') ?? '';
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

    const baseFee = t?.feePayer === address ? (Number(t?.fee) || 0) / 1e9 : 0;

    // Delta de SOL NATIVO da carteira nesta tx: a mudança REAL de saldo — já líquida de
    // taxa da plataforma (ex.: 1% da Axiom), tips do Jito, base fee e rent (todos saem do
    // saldo). A perna WSOL bruta NÃO reflete esses custos e superestima o resultado.
    //
    // FONTE = `accountData[].nativeBalanceChange` (mudança LÍQUIDA de saldo), NÃO a soma
    // de `nativeTransfers`: em vendas pagas em SOL nativo (pump.fun/bonding curve), os
    // proventos NÃO aparecem como nativeTransfer — só como balance change — então somar
    // transfers capturava apenas as taxas (saídas) e zerava a venda (prejuízo fantasma).
    let solNative = 0;
    let hasNative = false;
    const selfAcct = (t?.accountData ?? []).find(
      (a: any) => a?.account === address,
    );
    if (selfAcct && Number.isFinite(Number(selfAcct.nativeBalanceChange))) {
      solNative = Number(selfAcct.nativeBalanceChange) / 1e9;
      hasNative = solNative !== 0;
    } else {
      // Fallback (sem accountData): soma dos transfers, comportamento antigo.
      for (const n of t?.nativeTransfers ?? []) {
        const a = (Number(n?.amount) || 0) / 1e9;
        if (n.fromUserAccount === address) {
          solNative -= a;
          hasNative = true;
        }
        if (n.toUserAccount === address) {
          solNative += a;
          hasNative = true;
        }
      }
    }

    // quote: stablecoin tem valor USD direto; senão a contraparte é SOL.
    let quoteMint: string | null = null;
    for (const m of net.keys()) {
      if (HeliusSolanaProvider.STABLES.has(m)) {
        quoteMint = m;
        break;
      }
    }

    let quoteAmount: number;
    if (quoteMint) {
      quoteAmount = Math.abs(net.get(quoteMint) ?? 0);
    } else {
      // SOL: preferimos o delta nativo REAL. A perna WSOL (bruta) é usada quando o
      // movimento nativo é pequeno perto dela (rent incidental) ou inexistente. Sem
      // perna WSOL nem movimento nativo real → não há contraparte SOL (não é swap).
      const wsolLeg = Math.abs(net.get(HeliusSolanaProvider.WSOL) ?? 0);
      quoteMint = HeliusSolanaProvider.WSOL;
      if (wsolLeg >= 1e-12 && Math.abs(solNative) < 0.5 * wsolLeg) {
        quoteAmount = wsolLeg; // nativo incidental → perna WSOL
      } else if (hasNative && Math.abs(solNative) > 1e-9) {
        // Swap liquidado em SOL nativo: a mudança líquida de saldo (já inclui a base
        // fee/tips) É o valor real do swap. feeNative registra a base fee à parte.
        quoteAmount = Math.abs(solNative);
      } else {
        quoteAmount = wsolLeg; // 0 quando não há perna SOL → filtrado abaixo
      }
    }
    if (quoteAmount < 1e-12) return null;

    const baseDelta = net.get(baseMint) ?? 0;
    const side = baseDelta > 0 ? TradeSide.BUY : TradeSide.SELL;
    const feeNative = baseFee;

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

  /**
   * Snapshot (preço + liquidez) por mint via DexScreener (lotes de 30, grátis/sem key).
   * Escolhe o par de MAIOR liquidez de cada token. Mints sem par ficam ausentes do mapa.
   */
  private async dexScreenerSnapshots(
    mints: string[],
  ): Promise<Map<string, { priceUsd: number; liquidityUsd: number }>> {
    const out = new Map<string, { priceUsd: number; liquidityUsd: number }>();
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
          // Fica com o par de maior liquidez (proxy de preço mais confiável).
          if (liq > (out.get(mint)?.liquidityUsd ?? -1)) {
            out.set(mint, { priceUsd: price, liquidityUsd: liq });
          }
        }
      } catch {
        /* lote falhou → mints ficam sem snapshot */
      }
    }
    return out;
  }

  /** Só o preço (conveniência p/ o cálculo de saldo). */
  private async dexScreenerPrices(
    mints: string[],
  ): Promise<Map<string, number>> {
    const snaps = await this.dexScreenerSnapshots(mints);
    const out = new Map<string, number>();
    for (const [mint, s] of snaps) out.set(mint, s.priceUsd);
    return out;
  }

  // ─────────────────── Snapshots de token (survival) — DexScreener + cache ───────────────────

  fetchTokenSnapshot(
    _chain: Chain,
    mint: string,
  ): Promise<TokenSnapshot | null> {
    return this.fetchTokenSnapshots(_chain, [mint]).then(
      (m) => m.get(mint) ?? null,
    );
  }

  /**
   * Snapshots em LOTE (preço/liquidez) via DexScreener, SEM Moralis. Mesma estratégia
   * de custo do adapter Moralis: cache Redis por mint (hits não tocam a rede), misses
   * num único fetch batch; resultado (inclusive `null`) é cacheado — 6h resolvido,
   * 15min falha. Best-effort: qualquer erro deixa o mint como `null`.
   */
  async fetchTokenSnapshots(
    _chain: Chain,
    mints: string[],
  ): Promise<Map<string, TokenSnapshot | null>> {
    const out = new Map<string, TokenSnapshot | null>();
    if (mints.length === 0) return out;
    const uniq = [...new Set(mints)];

    // Camada 1: cache por mint.
    const misses: string[] = [];
    for (const mint of uniq) {
      const cached = this.cache
        ? await this.cache.getJson<{ v: TokenSnapshot | null }>(
            this.snapKey(mint),
          )
        : null;
      if (cached) out.set(mint, cached.v);
      else misses.push(mint);
    }
    if (misses.length === 0) return out;

    // Camada 2: um batch DexScreener p/ os misses.
    const snaps = await this.dexScreenerSnapshots(misses);

    // Camada 3: registra e cacheia (inclusive null, TTL curto).
    for (const mint of misses) {
      const s = snaps.get(mint);
      const snap: TokenSnapshot | null = s
        ? { priceUsd: String(s.priceUsd), liquidityUsd: String(s.liquidityUsd) }
        : null;
      out.set(mint, snap);
      await this.cache?.setJson(
        this.snapKey(mint),
        { v: snap },
        snap
          ? HeliusSolanaProvider.SNAP_TTL_OK
          : HeliusSolanaProvider.SNAP_TTL_MISS,
      );
    }
    return out;
  }

  private snapKey(mint: string): string {
    return `helius:snap:v1:${mint}`;
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
   * refazem chamada. Só bate no CoinGecko (grátis, sem key) para os dias que faltam,
   * num único intervalo contíguo — corta drasticamente o custo no backfill.
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

    // 2) CoinGecko market_chart/range SÓ do intervalo faltante (uma vez); cacheia cada dia.
    const fromSec = Math.floor(
      new Date(`${missing[0]}T00:00:00Z`).getTime() / 1000,
    );
    const toSec = Math.floor(
      new Date(`${missing[missing.length - 1]}T23:59:59Z`).getTime() / 1000,
    );
    const byDay = await this.coinGeckoSolDaily(fromSec, toSec);
    for (const [day, price] of byDay) {
      if (price > 0) {
        out.set(day, price);
        await this.cache?.setJson(
          this.solDayKey(day),
          price,
          HeliusSolanaProvider.SOLUSD_TTL,
        );
      }
    }
    return out;
  }

  /**
   * Preço diário do SOL (USD) via CoinGecko `coins/solana/market_chart/range` (grátis,
   * sem key; a granularidade varia com o range — bucketiza por dia UTC e fica com o
   * ÚLTIMO preço de cada dia ≈ fechamento). Best-effort → mapa vazio em falha.
   */
  private async coinGeckoSolDaily(
    fromSec: number,
    toSec: number,
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (this.coinGeckoKey) headers['x-cg-demo-api-key'] = this.coinGeckoKey;
      const resp = await firstValueFrom(
        this.http.get(`${this.coinGeckoBase}/coins/solana/market_chart/range`, {
          params: {
            vs_currency: 'usd',
            from: String(fromSec),
            to: String(toSec),
          },
          headers,
          timeout: 15000,
        } as any),
      );
      const prices: [number, number][] = Array.isArray(resp.data?.prices)
        ? resp.data.prices
        : [];
      // Último ponto de cada dia vence (prices vem em ordem cronológica).
      for (const [ms, price] of prices) {
        const day = new Date(ms).toISOString().slice(0, 10);
        const p = Number(price);
        if (p > 0) out.set(day, p);
      }
    } catch (err: any) {
      this.logger.warn(`Preço SOL/dia (CoinGecko) falhou: ${err?.message}`);
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
      const prices = await this.dexScreenerPrices([HeliusSolanaProvider.WSOL]);
      const p = prices.get(HeliusSolanaProvider.WSOL) ?? NaN;
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
