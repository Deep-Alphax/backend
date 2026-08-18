import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { Chain, Prisma, TradeSide } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  FetchSwapsParams,
  FetchSwapsResult,
  ProviderSwap,
  ProviderRequestError,
  TokenSnapshot,
} from './market-data-provider.interface';

/** Divide um array em lotes de tamanho `size` (p/ upserts em paralelo controlado). */
function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

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
  /**
   * Frescor (ms) do preço PERSISTIDO no banco (TokenPrice). Leitura mais nova que
   * isto é reusada sem tocar a API; mais velha → refetch + upsert. O preço alimenta
   * o não-realizado (posições em carteira), então precisa ser fresco.
   */
  private static readonly SNAP_FRESH_OK_MS = 5 * 60 * 1000;
  /** Frescor (ms) do preço NÃO resolvido (token morto) — curto, p/ auto-recuperar. */
  private static readonly SNAP_FRESH_MISS_MS = 15 * 60 * 1000;

  private readonly coinGeckoBase: string;
  private readonly coinGeckoKey: string;
  private readonly jupiterBase: string;
  /** IDs por chamada ao Jupiter Price API (limite prático do endpoint). */
  private static readonly JUP_BATCH = 100;
  /** Teto de mints precificados por carteira (holdings) — dust além disso vale ~0. */
  private static readonly MAX_PRICED_MINTS = 800;

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
    private readonly prisma: PrismaService,
  ) {
    this.apiKey = this.config.get<string>('HELIUS_API_KEY') ?? '';
    this.base =
      this.config.get<string>('HELIUS_BASE') ?? 'https://api.helius.xyz';
    this.coinGeckoBase =
      this.config.get<string>('COINGECKO_BASE') ??
      'https://api.coingecko.com/api/v3';
    // Opcional: key demo do CoinGecko (header x-cg-demo-api-key) sobe o rate limit.
    this.coinGeckoKey = this.config.get<string>('COINGECKO_API_KEY') ?? '';
    // Jupiter Price API (grátis): cobre ~todo token Solana com rota — muito além do
    // DexScreener. Primário de preço; DexScreener fica de fallback p/ os misses.
    this.jupiterBase =
      this.config.get<string>('JUPITER_PRICE_BASE') ??
      'https://lite-api.jup.ag/price/v3';
  }

  /**
   * Preço + liquidez (USD) por mint via Jupiter Price API v3 (grátis, sem key).
   * Cobre bonding-curve pump.fun / Meteora / qualquer token roteável — onde o
   * DexScreener falha. Lotes de JUP_BATCH; best-effort (lote que falha → misses).
   */
  private async jupiterSnapshots(
    mints: string[],
  ): Promise<Map<string, { priceUsd: number; liquidityUsd: number }>> {
    const out = new Map<string, { priceUsd: number; liquidityUsd: number }>();
    // Sem cap aqui: o teto vive em `resolveSnapshots` (que decide o conjunto
    // TENTADO). Cortar aqui fazia mints reais além do teto virarem "sem preço" e,
    // pior, serem persistidos como `null` (morto) → perda fantasma no não-realizado.
    const uniq = [...new Set(mints)];
    for (let i = 0; i < uniq.length; i += HeliusSolanaProvider.JUP_BATCH) {
      const chunk = uniq.slice(i, i + HeliusSolanaProvider.JUP_BATCH);
      try {
        const resp = await firstValueFrom(
          this.http.get(this.jupiterBase, {
            params: { ids: chunk.join(',') },
            headers: { accept: 'application/json' },
            timeout: 12000,
          } as any),
        );
        const data = resp.data ?? {};
        for (const mint of chunk) {
          const row = data[mint];
          const price = Number(row?.usdPrice);
          if (Number.isFinite(price) && price > 0) {
            out.set(mint, {
              priceUsd: price,
              liquidityUsd: Number(row?.liquidity) || 0,
            });
          }
        }
      } catch {
        /* lote falhou → mints ficam p/ o fallback */
      }
    }
    return out;
  }

  /**
   * Snapshot unificado (preço/liquidez) por mint: Jupiter primeiro (cobertura),
   * DexScreener só p/ os que o Jupiter não resolveu (fallback de liquidez).
   *
   * Retorna também `attempted` — os mints que DE FATO consultamos (limitados por
   * `MAX_PRICED_MINTS`). Só esses podem ser persistidos como `null` (morto) quando
   * sem preço; os pulados pelo teto NÃO são persistidos (re-tentados na próxima) —
   * senão um token real além do teto viraria "morto" e geraria perda fantasma.
   */
  private async resolveSnapshots(mints: string[]): Promise<{
    snaps: Map<string, { priceUsd: number; liquidityUsd: number }>;
    attempted: string[];
  }> {
    const uniq = [...new Set(mints)];
    if (uniq.length === 0) return { snaps: new Map(), attempted: [] };
    const attempted = uniq.slice(0, HeliusSolanaProvider.MAX_PRICED_MINTS);
    if (uniq.length > attempted.length) {
      this.logger.warn(
        `resolveSnapshots: ${uniq.length} mints > teto ${HeliusSolanaProvider.MAX_PRICED_MINTS}; ` +
          `${uniq.length - attempted.length} ficam p/ a próxima rodada (não marcados como mortos).`,
      );
    }
    const snaps = await this.jupiterSnapshots(attempted);
    const missing = attempted.filter((m) => !snaps.has(m));
    if (missing.length > 0) {
      const dex = await this.dexScreenerSnapshots(missing);
      for (const [m, v] of dex) if (!snaps.has(m)) snaps.set(m, v);
    }
    return { snaps, attempted };
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
   * Holdings ATUAIS on-chain (RPC): SOL (como WSOL) + SPL clássico + Token-2022.
   * `qty` = uiAmount (já com decimais). Fonte da VERDADE do que a carteira segura —
   * base p/ o saldo e p/ o não-realizado (valor realizável).
   */
  private async getOnchainHoldings(address: string): Promise<Map<string, number>> {
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

    const holdings = new Map<string, number>();
    const solAmount = Number(bal?.value ?? 0) / 1e9;
    if (solAmount > 0) holdings.set(HeliusSolanaProvider.WSOL, solAmount);
    for (const acc of [...(spl?.value ?? []), ...(spl22?.value ?? [])]) {
      const info = acc?.account?.data?.parsed?.info;
      const mint = info?.mint;
      const amt = Number(info?.tokenAmount?.uiAmount ?? 0);
      if (mint && amt > 0) holdings.set(mint, (holdings.get(mint) ?? 0) + amt);
    }
    return holdings;
  }

  /** Holdings on-chain reais (mint → qty). Best-effort → [] em falha. */
  async fetchWalletHoldings(
    _chain: Chain,
    address: string,
  ): Promise<Array<{ mint: string; qty: string }>> {
    try {
      const h = await this.getOnchainHoldings(address);
      return [...h.entries()].map(([mint, qty]) => ({ mint, qty: String(qty) }));
    } catch (err: any) {
      this.logger.warn(
        `Holdings Solana (RPC) falhou (${address}): ${err?.message}`,
      );
      return [];
    }
  }

  /**
   * Saldo ATUAL em USD = APENAS o SOL nativo × preço do SOL. Decisão de produto:
   * carteiras degen seguram milhares de memecoins pump.fun com preço nominal mas
   * liquidez ~zero (invendáveis) — somá-los inflava o saldo (ex.: $6,5k reais viravam
   * $8-26k). O SOL é o único ativo de fato líquido; é o que o Solscan mostra como
   * "SOL Balance". Tokens entram no PnL não-realizado (à parte), não no saldo.
   * 1 chamada RPC (getBalance) — barato. Best-effort → null em falha.
   */
  async fetchWalletBalanceUsd(
    _chain: Chain,
    address: string,
  ): Promise<string | null> {
    try {
      const bal = await this.rpcCall('getBalance', [address]);
      const solQty = Number(bal?.value ?? 0) / 1e9;
      if (!(solQty > 0)) return '0.00'; // sem SOL nativo
      const solPrice = await this.currentSolUsd();
      if (solPrice == null || !(solPrice > 0)) return null; // preço indisponível
      const total = solQty * solPrice;
      return Number.isFinite(total) ? total.toFixed(2) : null;
    } catch (err: any) {
      this.logger.warn(
        `Saldo SOL (RPC) falhou (${address}): ${err?.message}`,
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

  /**
   * Só o preço (conveniência p/ o cálculo de saldo). Passa pelo `fetchTokenSnapshots`
   * para reusar/PERSISTIR os preços no banco (TokenPrice) — nada de rede quando fresco.
   */
  private async dexScreenerPrices(
    mints: string[],
  ): Promise<Map<string, number>> {
    const snaps = await this.fetchTokenSnapshots(Chain.SOLANA, mints);
    const out = new Map<string, number>();
    for (const [mint, s] of snaps) {
      const price = s ? Number(s.priceUsd) : NaN;
      if (Number.isFinite(price) && price > 0) out.set(mint, price);
    }
    return out;
  }

  // ─────────────── Snapshots de token (survival) — Jupiter/DexScreener + DB ───────────────

  fetchTokenSnapshot(
    _chain: Chain,
    mint: string,
  ): Promise<TokenSnapshot | null> {
    return this.fetchTokenSnapshots(_chain, [mint]).then(
      (m) => m.get(mint) ?? null,
    );
  }

  /**
   * Snapshots em LOTE (preço/liquidez) via Jupiter + DexScreener, SEM Moralis.
   * PERSISTE no banco (tabela `TokenPrice`): hits frescos não tocam a rede; misses
   * vão num único fetch batch e o resultado (inclusive `null`) é gravado — frescor
   * de {@link SNAP_FRESH_OK_MS} p/ resolvido e {@link SNAP_FRESH_MISS_MS} p/ falha.
   * Best-effort: qualquer erro deixa o mint como `null`.
   */
  async fetchTokenSnapshots(
    chain: Chain,
    mints: string[],
  ): Promise<Map<string, TokenSnapshot | null>> {
    const out = new Map<string, TokenSnapshot | null>();
    if (mints.length === 0) return out;
    const uniq = [...new Set(mints)];
    const now = Date.now();

    // Camada 1: PERSISTIDO no banco (TokenPrice) — leituras frescas são reusadas.
    const rows = await this.prisma.getReadClient().tokenPrice.findMany({
      where: { chain, mint: { in: uniq } },
    });
    const byMint = new Map(rows.map((r) => [r.mint, r]));
    const misses: string[] = [];
    for (const mint of uniq) {
      const row = byMint.get(mint);
      const ttl =
        row?.priceUsd != null
          ? HeliusSolanaProvider.SNAP_FRESH_OK_MS
          : HeliusSolanaProvider.SNAP_FRESH_MISS_MS;
      if (row && now - row.fetchedAt.getTime() < ttl) {
        out.set(
          mint,
          row.priceUsd != null
            ? {
                priceUsd: row.priceUsd.toString(),
                liquidityUsd:
                  row.liquidityUsd != null ? row.liquidityUsd.toString() : null,
              }
            : null,
        );
      } else {
        misses.push(mint);
      }
    }
    if (misses.length === 0) return out;

    // Camada 2: Jupiter (primário) + DexScreener (fallback) p/ os misses.
    const { snaps, attempted } = await this.resolveSnapshots(misses);

    // Return: todo miss recebe seu snapshot (ou null se sem preço) p/ o chamador.
    for (const mint of misses) {
      const s = snaps.get(mint);
      out.set(
        mint,
        s
          ? { priceUsd: String(s.priceUsd), liquidityUsd: String(s.liquidityUsd) }
          : null,
      );
    }

    // Camada 3: PERSISTE no banco SÓ os mints TENTADOS (upsert por (chain, mint),
    // inclusive null=morto p/ os tentados-sem-preço). Mints além do teto ficam de
    // fora → re-tentados depois (nunca marcados como mortos por engano).
    const write = this.prisma.getWriteClient();
    for (const chunk of chunkArray(attempted, 100)) {
      await Promise.all(
        chunk.map((mint) => {
          const s = snaps.get(mint);
          const priceUsd = s ? new Prisma.Decimal(s.priceUsd) : null;
          const liquidityUsd = s ? new Prisma.Decimal(s.liquidityUsd) : null;
          return write.tokenPrice.upsert({
            where: { chain_mint: { chain, mint } },
            create: { chain, mint, priceUsd, liquidityUsd },
            update: { priceUsd, liquidityUsd, fetchedAt: new Date() },
          });
        }),
      );
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
    // Preenche buracos: o CoinGecko às vezes pula dias → o swap desse dia ficava
    // SEM preço (usdValue=0) e corrompia o PnL (perda fantasma no FIFO). Carrega o
    // dia conhecido mais próximo (fwd + back fill). Preço do SOL não varia tão
    // rápido entre dias vizinhos → aproximação muito melhor que $0.
    this.carryFillDays(byDay, from, to);
    // Fallback final: se não houver NENHUMA série diária, usa o preço atual do SOL.
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
   * Preço do SOL (USD) por dia (YYYY-MM-DD), PERSISTIDO no banco (SolDayPrice). O
   * fechamento diário é imutável → dia já salvo NUNCA refaz chamada. Só bate no
   * CoinGecko (grátis, sem key) para os dias que faltam, num único intervalo.
   */
  private async solUsdByDay(
    from: Date,
    to: Date,
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const days = this.enumerateDays(from, to);
    if (days.length === 0) return out;

    // 1) banco (imutável): dias já persistidos.
    const rows = await this.prisma.getReadClient().solDayPrice.findMany({
      where: { day: { in: days } },
    });
    const saved = new Set<string>();
    for (const r of rows) {
      const p = Number(r.priceUsd);
      if (p > 0) {
        out.set(r.day, p);
        saved.add(r.day);
      }
    }
    const missing = days.filter((d) => !saved.has(d));
    if (missing.length === 0) return out;

    // 2) CoinGecko market_chart/range SÓ do intervalo faltante (uma vez); persiste.
    const fromSec = Math.floor(
      new Date(`${missing[0]}T00:00:00Z`).getTime() / 1000,
    );
    const toSec = Math.floor(
      new Date(`${missing[missing.length - 1]}T23:59:59Z`).getTime() / 1000,
    );
    const byDay = await this.coinGeckoSolDaily(fromSec, toSec);
    // O dia de HOJE (UTC) ainda não fechou → NÃO persiste (senão congela um valor
    // intradiário como se fosse o fechamento). É reusado em memória e re-buscado no
    // próximo sync. Só dias já fechados vão pro banco (imutáveis).
    const today = new Date().toISOString().slice(0, 10);
    const data: { day: string; priceUsd: Prisma.Decimal }[] = [];
    for (const [day, price] of byDay) {
      if (price > 0) {
        out.set(day, price);
        if (day < today) data.push({ day, priceUsd: new Prisma.Decimal(price) });
      }
    }
    if (data.length > 0) {
      await this.prisma
        .getWriteClient()
        .solDayPrice.createMany({ data, skipDuplicates: true });
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


  /**
   * Preenche dias sem preço no mapa `byDay` carregando o dia conhecido mais
   * próximo: forward-fill (usa o último dia conhecido) e depois back-fill (para os
   * dias antes do primeiro conhecido). No-op se o mapa estiver vazio.
   */
  private carryFillDays(byDay: Map<string, number>, from: Date, to: Date): void {
    if (byDay.size === 0) return;
    const days = this.enumerateDays(from, to);
    let last: number | null = null;
    for (const d of days) {
      const v = byDay.get(d);
      if (v != null && v > 0) last = v;
      else if (last != null) byDay.set(d, last);
    }
    let next: number | null = null;
    for (let i = days.length - 1; i >= 0; i--) {
      const d = days[i];
      const v = byDay.get(d);
      if (v != null && v > 0) next = v;
      else if (next != null) byDay.set(d, next);
    }
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
