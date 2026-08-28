import { Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { firstValueFrom } from 'rxjs';
import { Chain, Prisma, SwapSource } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  MARKET_DATA_PROVIDER,
  type MarketDataProvider,
} from '../analytics/providers/market-data-provider.interface';
import SEED from './data/sidewallet-scans.seed.json';

const MIN_TRANSFER_USD = 3;
const MAX_TOKENS = 5;
const COPYTRADER_WINDOW_SECONDS = 24 * 3600;
const SELL_BEFORE_WINDOW_SECONDS = 15 * 60;
const MIN_TOKENS_FOR_PATTERN = 2;

/**
 * Rate limit da chave Birdeye, MEDIDO: 1100ms serial passa 6/6; 600ms cai para
 * 3/6; duas simultâneas já tomam 429. Ou seja, não há concorrência a explorar —
 * cada chamada custa ~1,1s fixo, e a única alavanca de performance é FAZER
 * MENOS CHAMADAS. É o que dita o desenho da varredura abaixo.
 */
/** Estado de uma varredura mudou → o gateway repassa por socket. */
export const WALLET_SCAN_STATE_EVENT = 'wallet-scan.state';

export interface WalletScanStateEvent {
  kolId: string;
  status: string;
  result: ScanResult;
}

const CALL_SPACING_MS = 1100;
const BIRDEYE_PAGE = 50;

/**
 * Tentativas por varredura. 429 e timeout de provider são falhas TRANSITÓRIAS —
 * queimar a varredura na primeira é jogar fora trabalho que ia dar certo em
 * alguns segundos.
 */
const MAX_ATTEMPTS = 3;

/**
 * Teto de candidatos verificados. Cada um custa ~1,1s de Birdeye, mas a
 * varredura roda em FILA — quem pediu não fica esperando —, então vale ser
 * generoso: no Eddy foram 35 candidatos e 10 cortava demais.
 */
const MAX_CANDIDATES = 25;

/**
 * Acima disto, o endereço negocia tokens demais para ser carteira pessoal —
 * é bot, roteador de DEX ou saque de corretora. Filtro anti-ruído da descoberta.
 */
const INFRA_DISTINCT_MINTS = 25;

/**
 * Validade de um scan. O resultado de um KOL do preset é IGUAL para todos os
 * usuários, então revarrer por pedido é desperdício: 500 usuários nos mesmos
 * 275 KOLs viram 275 varreduras, não 500 × 275.
 */
const SCAN_TTL_MS = 6 * 3600 * 1000;

/** Validade da atividade recente de uma carteira (muda conforme ela negocia). */
const ACTIVITY_TTL_MS = 6 * 3600 * 1000;

/**
 * Validade dos swaps de um candidato numa janela PASSADA. História não muda,
 * então vale bem mais — o TTL aqui existe só para a linha não viver para sempre.
 */
const HISTORY_TTL_MS = 7 * 24 * 3600 * 1000;

/**
 * Orçamento de tempo da fase de verificação. O link direto (transferência) já
 * classifica o achado sozinho; a verificação só ENRIQUECE com o padrão temporal.
 * Estourou o tempo, devolve o que tem em vez de deixar a UI pendurada.
 */
const VERIFY_BUDGET_MS = 30_000;

/** Quantas transações recentes da carteira pública o Helius devolve por vez. */
const HELIUS_TX_LIMIT = 100;

/**
 * Ativos de COTAÇÃO — o dinheiro do par, nunca o alvo da varredura.
 *
 * A Birdeye não garante que o token negociado venha na perna `base`: numa venda
 * de memecoin por SOL, `base` é o SOL. Sem esta normalização a varredura ia
 * procurar "quem mais negociou SOL", onde 200 swaps cobrem segundos — e não
 * achava nada, em nenhum KOL.
 */
const QUOTE_MINTS = new Set<string>([
  'So11111111111111111111111111111111111111112', // WSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB', // USD1
]);

interface WalletRef {
  name: string;
  address: string;
}

export interface ScanFlagged {
  address: string;
  name: string | null;
  ownerKolId: string | null;
  ownerKolName: string | null;
  role: 'sidewallet' | 'copytrader';
  confidence: 'high' | 'medium' | 'info';
  recognizedElsewhere: boolean;
  recognizedAs: string | null;
  signals: string[];
  reason: string;
  evidence: unknown[];
}
/** Scan sem as evidências — o que a listagem precisa. */
export type ScanSummary = Omit<ScanResult, 'flagged'>;

export interface ScanResult {
  kolId: string;
  kolName: string;
  scannedAt: number;
  /** `queued`/`running` existem porque a varredura saiu do caminho da request. */
  status: 'queued' | 'running' | 'complete' | 'error';
  publicWallet: string;
  tokensAnalyzed: number;
  apiCalls: number;
  flagged: ScanFlagged[];
  summary: string;
}

interface Finding {
  address: string;
  /** Já cadastrado no índice? `false` = endereço DESCOBERTO agora. */
  known: boolean;
  /** Passou pela checagem temporal (só os candidatos melhor ranqueados passam). */
  verified: boolean;
  /** Nº de tokens analisados que este endereço também negociou. */
  sharedTokens: number;
  name: string | null;
  ownerKolId: string | null;
  ownerKolName: string | null;
  signals: Set<string>;
  evidence: any[];
  recognizedElsewhere: boolean;
  recognizedAs: string | null;
}

/**
 * Varredura de sidewallets/copytraders (port do `scripts/sidewallet-scan.js`).
 * Dados on-chain reais, sem dependência de binário externo:
 *  - swaps da carteira pública → provider já plugado (`MARKET_DATA_PROVIDER`);
 *  - transferências recebidas → Helius (transações enriquecidas);
 *  - quem mais negociou cada token → Birdeye (`/defi/txs/token`).
 *
 * Escopo: só as carteiras já no índice (`KolPreset`), não a Solana inteira — é o
 * que torna a pergunta respondível barato. Resultados persistem em `WalletScan`.
 */
@Injectable()
export class WalletReaderService implements OnModuleInit {
  private readonly logger = new Logger(WalletReaderService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly http: HttpService,
    private readonly config: ConfigService,
    private readonly events: EventEmitter2,
    @Inject(MARKET_DATA_PROVIDER) private readonly market: MarketDataProvider,
  ) {}

  /** Seed dos scans cacheados (1×, se a tabela estiver vazia). */
  async onModuleInit(): Promise<void> {
    try {
      const count = await this.prisma.getReadClient().walletScan.count();
      if (count > 0) return;
      const scans = (SEED as { scans?: Record<string, ScanResult> }).scans ?? {};
      const rows = Object.values(scans);
      if (!rows.length) return;
      await this.prisma.getWriteClient().walletScan.createMany({
        data: rows.map((s) => ({
          kolId: s.kolId,
          kolName: s.kolName,
          scannedAt: new Date(s.scannedAt),
          status: s.status,
          publicWallet: s.publicWallet,
          tokensAnalyzed: s.tokensAnalyzed ?? 0,
          apiCalls: s.apiCalls ?? 0,
          flagged: (s.flagged ?? []) as unknown as Prisma.InputJsonValue,
          summary: s.summary,
        })),
        skipDuplicates: true,
      });
      this.logger.log(`Seed de ${rows.length} scans de sidewallets.`);
    } catch (e: any) {
      this.logger.warn(`Falha no seed de scans: ${e?.message}`);
    }

    // A fila vive no processo, mas o ESTADO dela está no banco: o que ficou
    // "queued"/"running" num restart voltaria a existir só como linha órfã.
    try {
      const pending = await this.prisma.getReadClient().walletScan.findMany({
        where: { status: { in: ['queued', 'running'] } },
        select: { kolId: true, publicWallet: true },
      });
      pending.forEach((r) => this.enqueue(r.kolId, r.publicWallet));
      if (pending.length) {
        this.logger.log(`Reenfileiradas ${pending.length} varreduras pendentes.`);
      }
    } catch {
      // Sem recuperação de fila — o usuário pode pedir de novo.
    }
  }

  /**
   * RESUMO de todos os scans — sem o `flagged`.
   *
   * A tela carrega isto no page load só para saber quem já foi varrido; as
   * evidências de um KOL só interessam quando o modal dele abre. Mandar o
   * `flagged` de 276 KOLs aqui seria centenas de KB que quase ninguém olha.
   */
  async getScanSummaries(): Promise<{ scans: Record<string, ScanSummary> }> {
    // Um KOL pode ter uma varredura por carteira; a listagem mostra a mais
    // recente — é o que a rail usa para saber quem já foi varrido.
    const rows = await this.prisma.getReadClient().walletScan.findMany({
      orderBy: { scannedAt: 'asc' },
      select: {
        kolId: true,
        kolName: true,
        scannedAt: true,
        status: true,
        publicWallet: true,
        tokensAnalyzed: true,
        apiCalls: true,
        summary: true,
      },
    });
    const scans: Record<string, ScanSummary> = {};
    for (const r of rows) {
      scans[r.kolId] = {
        kolId: r.kolId,
        kolName: r.kolName,
        scannedAt: r.scannedAt.getTime(),
        status: r.status as ScanResult['status'],
        publicWallet: r.publicWallet,
        tokensAnalyzed: r.tokensAnalyzed,
        apiCalls: r.apiCalls,
        summary: r.summary,
      };
    }
    return { scans };
  }

  /**
   * TODAS as varreduras de um KOL — uma por carteira já varrida, com as
   * evidências. O modal escolhe qual carteira mostrar.
   */
  async getScansOf(kolId: string): Promise<ScanResult[]> {
    const rows = await this.prisma.getReadClient().walletScan.findMany({
      where: { kolId },
      orderBy: { scannedAt: 'desc' },
    });
    return rows.map((r) => this.toResult(r));
  }

  // ── item 4: poda do cache on-chain ─────────────────────────────────────────

  /**
   * Apaga leitura on-chain vencida.
   *
   * `OnchainCache` ganha uma linha por endereço e por janela; sem poda vira
   * acúmulo silencioso em disco. O TTL de leitura já ignora a linha velha — o
   * cron só recupera o espaço.
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async pruneOnchainCache(): Promise<void> {
    try {
      const { count } = await this.prisma.getWriteClient().onchainCache.deleteMany({
        where: { fetchedAt: { lt: new Date(Date.now() - HISTORY_TTL_MS) } },
      });
      if (count) this.logger.log(`Poda do cache on-chain: ${count} linhas.`);
    } catch (e: any) {
      this.logger.warn(`Falha na poda do cache on-chain: ${e?.message}`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Instante da última chamada à Birdeye — o rate limit é da CHAVE, não do token. */
  private lastBirdeyeAt = 0;

  /**
   * Espaça as chamadas à Birdeye globalmente. Espaçar só dentro de um token não
   * bastava: a primeira página de cada token saía em rajada e tomava 429, o que
   * truncava a varredura inteira.
   */
  private async paceBirdeye(): Promise<void> {
    const wait = this.lastBirdeyeAt + CALL_SPACING_MS - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.lastBirdeyeAt = Date.now();
  }

  /**
   * Leitura on-chain com cache NO BANCO (`OnchainCache`).
   *
   * O dado é o mesmo para qualquer usuário e, no caso de janela passada, também
   * é imutável. Com a Birdeye em ~1 req/s, reaproveitar é a diferença entre uma
   * varredura de 2s e uma de 15s — e duas varreduras que compartilham um
   * candidato pagam a chamada uma vez só.
   */
  private async cachedFetch<T>(
    key: string,
    ttlMs: number,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    const hit = await this.prisma
      .getReadClient()
      .onchainCache.findUnique({ where: { key } });
    if (hit && Date.now() - hit.fetchedAt.getTime() < ttlMs) {
      return hit.payload as unknown as T;
    }

    const fresh = await fetcher();
    const payload = fresh as unknown as Prisma.InputJsonValue;
    await this.prisma
      .getWriteClient()
      .onchainCache.upsert({
        where: { key },
        create: { key, payload },
        update: { payload, fetchedAt: new Date() },
      })
      // Falha de cache nunca derruba a varredura — o dado já está em mãos.
      .catch(() => undefined);
    return fresh;
  }

  /**
   * Universo do índice: todo endereço de todo KOL do PRESET → dono.
   *
   * É o filtro que dá sentido à varredura: só vira achado o endereço que já está
   * no índice. Sem isso a pergunta viraria "quem no mundo negociou este token",
   * que nenhuma API responde barato — e encheria o resultado de ruído.
   */
  private async buildUniverse(): Promise<
    Map<string, { kolId: string; kolName: string; walletName: string }>
  > {
    const rows = await this.prisma.getReadClient().kolPreset.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, wallets: true },
    });
    const map = new Map<string, { kolId: string; kolName: string; walletName: string }>();
    for (const r of rows) {
      const wallets = Array.isArray(r.wallets) ? (r.wallets as unknown as WalletRef[]) : [];
      for (const w of wallets) {
        if (w?.address) {
          map.set(w.address, {
            kolId: r.id,
            kolName: r.name,
            walletName: w.name ?? 'Carteira',
          });
        }
      }
    }
    return map;
  }

  /**
   * Qual perna do par é o TOKEN NEGOCIADO, e de que lado o KOL ficou.
   *
   * O provider entrega `base`/`quote` como a fonte mandou. Quando `base` é o
   * ativo de cotação (SOL/stable), quem foi negociado é o `quote` — e o lado se
   * inverte: "comprou SOL" é, na verdade, "vendeu o memecoin". Par de dois
   * ativos de cotação (ex.: SOL↔USDC) não é alvo de varredura.
   */
  private tradedLeg(sw: {
    side: string;
    baseMint: string;
    baseSymbol?: string | null;
    quoteMint: string;
    quoteSymbol?: string | null;
    priceUsd: string;
  }): { mint: string; symbol: string; side: 'BUY' | 'SELL'; priceUsd: number } | null {
    const baseIsQuote = QUOTE_MINTS.has(sw.baseMint);
    const quoteIsQuote = QUOTE_MINTS.has(sw.quoteMint);
    if (baseIsQuote && quoteIsQuote) return null;

    if (!baseIsQuote) {
      return {
        mint: sw.baseMint,
        symbol: sw.baseSymbol ?? sw.baseMint.slice(0, 4),
        side: sw.side === 'BUY' ? 'BUY' : 'SELL',
        priceUsd: Number(sw.priceUsd) || 0,
      };
    }
    return {
      mint: sw.quoteMint,
      symbol: sw.quoteSymbol ?? sw.quoteMint.slice(0, 4),
      side: sw.side === 'BUY' ? 'SELL' : 'BUY',
      // O preço do provider é do `base`; na perna invertida não vale — o USD
      // aqui só alimenta o piso de ruído das transferências.
      priceUsd: 0,
    };
  }

  /**
   * Últimos tokens negociados pela carteira pública, via provider de swaps já
   * plugado (Solana → Birdeye/Helius). Devolve os `MAX_TOKENS` mints comprados
   * mais recentes, com o instante da compra e o da PRIMEIRA venda de cada um.
   */
  private async recentTokens(address: string): Promise<
    Array<{
      address: string;
      symbol: string;
      kolBuyAt: number;
      kolSellAt: number | null;
      priceUsd: number;
    }>
  > {
    return this.cachedFetch(`tokens:sol:${address}`, ACTIVITY_TTL_MS, async () =>
      this.recentTokensFresh(address),
    );
  }

  private async recentTokensFresh(address: string): Promise<
    Array<{
      address: string;
      symbol: string;
      kolBuyAt: number;
      kolSellAt: number | null;
      priceUsd: number;
    }>
  > {
    // Helius PRIMEIRO de propósito: o default para Solana é a Birdeye, e cada
    // chamada dela custa ~1,1s de rate limit. Mas a reconstrução do Helius não
    // cobre toda carteira — quando ela não devolve nada, cai na Birdeye, que aí
    // vale o 1,1s (sem tokens não há varredura nenhuma).
    const pick = async (source: SwapSource | null) =>
      (
        await this.market.fetchSwaps({
          source,
          chain: Chain.SOLANA,
          address,
          limit: HELIUS_TX_LIMIT,
        })
      ).swaps;

    // A condição olha COMPRA, não swap qualquer: a varredura parte dos tokens
    // que o KOL comprou, então uma lista só de vendas é tão inútil quanto vazia.
    let swaps = await pick(SwapSource.HELIUS).catch(() => []);
    if (!swaps.some((sw) => this.tradedLeg(sw)?.side === 'BUY')) {
      await this.paceBirdeye();
      swaps = await pick(SwapSource.BIRDEYE).catch(() => []);
    }
    // Mais novo primeiro — o corte "últimos N" é por ordem de compra.
    const ordered = swaps
      .slice()
      .sort((a, b) => b.blockTime.getTime() - a.blockTime.getTime());

    const tokens: Array<{
      address: string;
      symbol: string;
      kolBuyAt: number;
      kolSellAt: number | null;
      priceUsd: number;
    }> = [];

    for (const sw of ordered) {
      const t = this.tradedLeg(sw);
      if (!t || t.side !== 'BUY') continue;
      if (tokens.length >= MAX_TOKENS) break;
      if (tokens.some((x) => x.address === t.mint)) continue;
      tokens.push({
        address: t.mint,
        symbol: t.symbol,
        kolBuyAt: Math.floor(sw.blockTime.getTime() / 1000),
        kolSellAt: null,
        priceUsd: t.priceUsd,
      });
    }

    // Venda mais ANTIGA de cada token = início da saída da posição.
    for (const sw of ordered) {
      const t = this.tradedLeg(sw);
      if (!t || t.side !== 'SELL') continue;
      const tok = tokens.find((x) => x.address === t.mint);
      if (!tok) continue;
      const ts = Math.floor(sw.blockTime.getTime() / 1000);
      if (tok.kolSellAt === null || ts < tok.kolSellAt) tok.kolSellAt = ts;
    }

    return tokens;
  }

  /**
   * Transferências RECEBIDAS pela carteira pública, direto da API de transações
   * enriquecidas do Helius. É o sinal de LINK DIRETO: alguém mandou o mesmo
   * token para a carteira pública.
   *
   * Devolve a QUANTIDADE crua: roda em paralelo com os swaps, então ainda não
   * há preço para converter. Quem chama multiplica pelo preço do token (a API de
   * transferência não traz USD) — serve só para o piso de ruído.
   */
  private async incomingTransfers(
    address: string,
  ): Promise<
    Array<{ from: string; mint: string; amount: number; at: number; tx: string }>
  > {
    return this.cachedFetch(`transfers:sol:${address}`, ACTIVITY_TTL_MS, async () =>
      this.incomingTransfersFresh(address),
    );
  }

  private async incomingTransfersFresh(
    address: string,
  ): Promise<
    Array<{ from: string; mint: string; amount: number; at: number; tx: string }>
  > {
    const key = this.config.get<string>('HELIUS_API_KEY') ?? '';
    if (!key) return [];
    const base = this.config.get<string>('HELIUS_BASE') ?? 'https://api.helius.xyz';

    const { data } = await firstValueFrom(
      this.http.get<any[]>(`${base}/v0/addresses/${address}/transactions`, {
        params: { 'api-key': key, limit: HELIUS_TX_LIMIT },
        timeout: 25000,
      }),
    );

    const out: Array<{ from: string; mint: string; amount: number; at: number; tx: string }> = [];
    for (const tx of Array.isArray(data) ? data : []) {
      for (const t of tx?.tokenTransfers ?? []) {
        if (t?.toUserAccount !== address) continue;
        const from = t?.fromUserAccount;
        const mint = t?.mint;
        if (!from || !mint || from === address) continue;
        out.push({
          from,
          mint,
          amount: Number(t.tokenAmount) || 0,
          at: Number(tx.timestamp) || 0,
          tx: String(tx.signature ?? ''),
        });
      }
    }
    return out;
  }

  /**
   * Swaps de UM candidato num ponto qualquer do histórico, via Birdeye
   * `/trader/txs/seek_by_time`.
   *
   * É a INVERSÃO da pergunta: em vez de "quem negociou o token X na época T"
   * — que exige o seek por tempo no endpoint de TOKEN, e esse dá 401 no plano
   * atual —, pergunta "a carteira Y negociou algo na época T". Esse endpoint
   * aceita `before_time` e salta para qualquer ponto do histórico numa chamada,
   * então a idade do trade deixa de importar.
   *
   * `before_time` e `after_time` são mutuamente exclusivos aqui (mandar os dois
   * devolve 422), por isso só o `before_time`.
   */
  private async candidateSwaps(
    address: string,
    beforeTs: number,
  ): Promise<Array<{ mint: string; side: 'BUY' | 'SELL'; at: number }>> {
    // Janela PASSADA → história imutável, cache longo. É o que evita repagar a
    // mesma chamada quando dois KOLs compartilham um candidato.
    return this.cachedFetch(
      `cand:sol:${address}:${beforeTs}`,
      HISTORY_TTL_MS,
      async () => this.candidateSwapsFresh(address, beforeTs),
    );
  }

  private async candidateSwapsFresh(
    address: string,
    beforeTs: number,
  ): Promise<Array<{ mint: string; side: 'BUY' | 'SELL'; at: number }>> {
    const key = this.config.get<string>('BIRDEYE_API_KEY') ?? '';
    if (!key) return [];
    const base =
      this.config.get<string>('BIRDEYE_BASE') ?? 'https://public-api.birdeye.so';

    await this.paceBirdeye();
    const { data } = await firstValueFrom(
      this.http.get<any>(`${base}/trader/txs/seek_by_time`, {
        params: {
          address,
          limit: BIRDEYE_PAGE,
          tx_type: 'swap',
          before_time: beforeTs,
        },
        headers: { 'X-API-KEY': key, 'x-chain': 'solana' },
        timeout: 25000,
      }),
    );

    const out: Array<{ mint: string; side: 'BUY' | 'SELL'; at: number }> = [];
    for (const it of data?.data?.items ?? []) {
      const at = Number(it?.block_unix_time) || 0;
      if (!at) continue;
      // Mesma normalização de perna dos swaps do KOL: o alvo nunca é o SOL.
      const leg = this.tradedLeg({
        side: Number(it?.base?.ui_change_amount ?? 0) > 0 ? 'BUY' : 'SELL',
        baseMint: String(it?.base?.address ?? ''),
        baseSymbol: it?.base?.symbol,
        quoteMint: String(it?.quote?.address ?? ''),
        quoteSymbol: it?.quote?.symbol,
        priceUsd: '0',
      });
      if (leg) out.push({ mint: leg.mint, side: leg.side, at });
    }
    return out;
  }

  private async persist(result: ScanResult): Promise<ScanResult> {
    const data = {
      kolName: result.kolName,
      scannedAt: new Date(result.scannedAt),
      status: result.status,
      tokensAnalyzed: result.tokensAnalyzed,
      apiCalls: result.apiCalls,
      flagged: result.flagged as unknown as Prisma.InputJsonValue,
      summary: result.summary,
    };
    await this.prisma.getWriteClient().walletScan.upsert({
      where: {
        kolId_publicWallet: { kolId: result.kolId, publicWallet: result.publicWallet },
      },
      create: { kolId: result.kolId, publicWallet: result.publicWallet, ...data },
      update: data,
    });
    return result;
  }

  /** Roda a varredura de um KOL e persiste o resultado. */
  // ── Fila ───────────────────────────────────────────────────────────────────
  // Serial de propósito: a Birdeye é ~1 req/s por CHAVE, então mais de um worker
  // só produziria 429. A fila tira a varredura do caminho da request e desacopla
  // a concorrência de usuários do limite do provider.
  private readonly queue: string[] = [];
  private draining = false;
  /** Tentativas já gastas por KOL (limpa ao concluir ou ao desistir). */
  private readonly attempts = new Map<string, number>();

  /** Backoff exponencial com teto: 2s, 4s, 8s… até 30s. */
  private backoffMs(attempt: number): number {
    return Math.min(30_000, 2000 * 2 ** (attempt - 1));
  }

  /** Marca o estado de uma varredura sem reescrever o resultado inteiro. */
  private async markStatus(
    kolId: string,
    address: string,
    status: string,
    summary: string,
  ): Promise<void> {
    await this.prisma
      .getWriteClient()
      .walletScan.updateMany({
        where: { kolId, publicWallet: address },
        data: { status, summary },
      })
      .catch(() => undefined);
  }

  /** Converte a linha persistida no formato de resposta. */
  private toResult(row: {
    kolId: string;
    kolName: string;
    scannedAt: Date;
    status: string;
    publicWallet: string;
    tokensAnalyzed: number;
    apiCalls: number;
    flagged: Prisma.JsonValue;
    summary: string;
  }): ScanResult {
    return {
      kolId: row.kolId,
      kolName: row.kolName,
      scannedAt: row.scannedAt.getTime(),
      status: row.status as ScanResult['status'],
      publicWallet: row.publicWallet,
      tokensAnalyzed: row.tokensAnalyzed,
      apiCalls: row.apiCalls,
      flagged: (row.flagged as unknown as ScanFlagged[]) ?? [],
      summary: row.summary,
    };
  }

  /**
   * Ponto de entrada do endpoint: responde NA HORA.
   *
   * Devolve o scan em cache se ainda vale, o estado atual se já está na fila, ou
   * enfileira e volta como `queued`. O resultado final chega por socket.
   */
  async requestScan(
    kolId: string,
    address?: string,
    force = false,
  ): Promise<ScanResult> {
    const preset = await this.prisma.getReadClient().kolPreset.findFirst({
      where: { id: kolId, deletedAt: null },
      select: { id: true, name: true, wallets: true },
    });
    if (!preset) throw new NotFoundException('KOL não encontrado no preset: ' + kolId);
    const wallets = Array.isArray(preset.wallets)
      ? (preset.wallets as unknown as WalletRef[])
      : [];
    if (!wallets.length) throw new NotFoundException('KOL sem carteiras: ' + kolId);

    // A carteira é ESCOLHIDA por quem pede; sem escolha, a primeira. Só aceita
    // endereço que pertence a este KOL — senão viraria varredura arbitrária.
    const target = address
      ? wallets.find((w) => w.address === address)
      : wallets[0];
    if (!target) {
      throw new NotFoundException('Carteira não pertence a este KOL: ' + address);
    }

    const existing = await this.prisma
      .getReadClient()
      .walletScan.findUnique({
        where: { kolId_publicWallet: { kolId, publicWallet: target.address } },
      });
    if (existing) {
      const state = this.toResult(existing);
      // Já em andamento: não duplica trabalho.
      if (state.status === 'queued' || state.status === 'running') return state;
      // Fresco o bastante: o resultado é o mesmo para todo usuário.
      if (
        !force &&
        state.status === 'complete' &&
        Date.now() - state.scannedAt < SCAN_TTL_MS
      ) {
        return state;
      }
    }

    const queued = await this.persist({
      kolId,
      kolName: preset.name,
      scannedAt: Date.now(),
      status: 'queued',
      publicWallet: target.address,
      tokensAnalyzed: 0,
      apiCalls: 0,
      flagged: [],
      summary: 'Varredura na fila — o resultado chega assim que terminar.',
    });
    this.enqueue(kolId, target.address);
    return queued;
  }

  /** A fila guarda o PAR: um KOL pode ter uma varredura por carteira. */
  private enqueue(kolId: string, address: string): void {
    const job = `${kolId}|${address}`;
    if (!this.queue.includes(job)) this.queue.push(job);
    void this.drain();
  }

  /** Drena a fila um por vez e avisa por evento a cada conclusão. */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift()!;
        const [kolId, address] = job.split('|');
        const attempt = (this.attempts.get(job) ?? 0) + 1;
        this.attempts.set(job, attempt);

        let result: ScanResult;
        try {
          await this.markStatus(kolId, address, 'running', 'Varredura em andamento…');
          result = await this.scanKol(kolId, address);
        } catch (e: any) {
          // Erro de DOMÍNIO (KOL saiu do preset, ficou sem carteira): tentar de
          // novo não muda nada. Encerra aqui.
          this.attempts.delete(job);
          this.logger.warn(`Varredura de ${job} abortada: ${e?.message}`);
          await this.markStatus(
            kolId,
            address,
            'error',
            `Varredura não pôde rodar: ${e?.message}`,
          );
          continue;
        }

        // `scanKol` não lança quando o PROVIDER falha — devolve status 'error'.
        // Esse é o caso transitório que vale repetir.
        if (result.status === 'error' && attempt < MAX_ATTEMPTS) {
          const wait = this.backoffMs(attempt);
          this.logger.warn(
            `Varredura de ${job} falhou (tentativa ${attempt}/${MAX_ATTEMPTS}); repetindo em ${wait}ms.`,
          );
          await this.markStatus(
            kolId,
            address,
            'queued',
            `Falha transitória — nova tentativa (${attempt + 1}/${MAX_ATTEMPTS}) em instantes.`,
          );
          // Reenfileira DEPOIS do backoff, sem travar a fila enquanto espera.
          setTimeout(() => this.enqueue(kolId, address), wait).unref?.();
          continue;
        }

        this.attempts.delete(job);
        this.events.emit(WALLET_SCAN_STATE_EVENT, {
          kolId,
          status: result.status,
          result,
        } satisfies WalletScanStateEvent);
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Varredura de sidewallets/copytraders de um KOL do PRESET.
   *
   * Cruza os últimos `MAX_TOKENS` tokens da carteira pública contra as outras
   * carteiras do índice, e só confirma com EVIDÊNCIA FORTE: link direto
   * on-chain (transferência entre as duas) ou padrão repetido em ao menos
   * `MIN_TOKENS_FOR_PATTERN` tokens. Coincidência isolada é descartada.
   */
  async scanKol(kolId: string, address?: string): Promise<ScanResult> {
    const preset = await this.prisma.getReadClient().kolPreset.findFirst({
      where: { id: kolId, deletedAt: null },
      select: { id: true, name: true, wallets: true },
    });
    // A varredura é do preset: um KOL criado por um usuário só existe na conta
    // dele, e o cache de scans (`WalletScan`) não tem dono.
    if (!preset) throw new NotFoundException('KOL não encontrado no preset: ' + kolId);
    const profileWallets = Array.isArray(preset.wallets)
      ? (preset.wallets as unknown as WalletRef[])
      : [];
    if (!profileWallets.length) {
      throw new NotFoundException('KOL sem carteiras: ' + kolId);
    }

    const universe = await this.buildUniverse();
    const ownAddrs = new Set(profileWallets.map((w) => w.address));
    // A carteira varrida é a escolhida por quem pediu (a primeira, por omissão).
    // As outras do KOL seguem em `ownAddrs`, para não virarem achado de si mesmas.
    const publicWallet =
      profileWallets.find((w) => w.address === address) ?? profileWallets[0];
    let apiCalls = 0;

    const fail = (message: string) =>
      this.persist({
        kolId,
        kolName: preset.name,
        scannedAt: Date.now(),
        status: 'error',
        publicWallet: publicWallet.address,
        tokensAnalyzed: 0,
        apiCalls,
        flagged: [],
        summary: `Varredura falhou: ${message}.`,
      });

    // 1. Carteira pública: swaps + transferências recebidas, EM PARALELO.
    //    Ambas saem do Helius (sem rate limit apertado), então custam o tempo de
    //    UMA — e nenhuma chamada Birdeye é gasta nesta fase.
    let tokens: Awaited<ReturnType<typeof this.recentTokens>>;
    let transfers: Awaited<ReturnType<typeof this.incomingTransfers>>;
    try {
      [tokens, transfers] = await Promise.all([
        this.recentTokens(publicWallet.address),
        this.incomingTransfers(publicWallet.address).catch(() => []),
      ]);
      apiCalls += 2;
    } catch (e: any) {
      return fail(e?.message ?? 'provider de swaps indisponível');
    }

    if (!tokens.length) {
      return this.persist({
        kolId,
        kolName: preset.name,
        scannedAt: Date.now(),
        status: 'complete',
        publicWallet: publicWallet.address,
        tokensAnalyzed: 0,
        apiCalls,
        flagged: [],
        summary: `A carteira pública de ${preset.name} não tem compras recentes on-chain — nada pra analisar.`,
      });
    }

    const findings = new Map<string, Finding>();
    /**
     * Entra no radar QUALQUER endereço que não seja do próprio KOL — inclusive
     * um que ainda não está no índice.
     *
     * Antes o filtro era `if (!universe.has(address)) return null`, e a
     * varredura só sabia reconhecer carteira JÁ cadastrada: no Eddy ela achou
     * 35 contrapartes e descartou as 35. Estar no índice virou anotação (de
     * quem é o endereço), não requisito.
     */
    const touch = (address: string): Finding | null => {
      if (ownAddrs.has(address)) return null;
      if (!findings.has(address)) {
        const known = universe.get(address);
        findings.set(address, {
          address,
          known: Boolean(known),
          verified: false,
          sharedTokens: 0,
          name: known?.walletName ?? null,
          ownerKolId: known?.kolId ?? null,
          ownerKolName: known?.kolName ?? null,
          signals: new Set(),
          evidence: [],
          recognizedElsewhere: Boolean(known) && known!.kolId !== kolId,
          recognizedAs: known && known.kolId !== kolId ? known.kolName : null,
        });
      }
      return findings.get(address)!;
    };

    // 2. LINK DIRETO: quem mandou um dos tokens analisados para a carteira
    //    pública. É daqui que saem os candidatos — reduzir o universo de 499
    //    endereços para um punhado é o que torna a fase 3 barata.
    const priceByMint = new Map(tokens.map((t) => [t.address, t.priceUsd]));
    const byMint = new Map(tokens.map((t) => [t.address, t]));
    for (const tr of transfers) {
      const tok = byMint.get(tr.mint);
      if (!tok) continue;
      const usd = tr.amount * (priceByMint.get(tr.mint) ?? 0);
      if (usd && usd < MIN_TRANSFER_USD) continue;
      const f = touch(tr.from);
      if (!f) continue;
      f.signals.add('transfer');
      f.evidence.push({
        type: 'transfer',
        token: tok.symbol,
        tokenAddress: tok.address,
        transferUsd: usd,
        transferAt: tr.at,
        transferTx: tr.tx,
      });
    }

    // 3. PADRÃO REPETIDO: para cada candidato, uma chamada que salta direto para
    //    a janela da atividade do KOL. Serial e com orçamento de tempo — cada
    //    chamada Birdeye custa ~1,1s e não há concorrência possível.
    const newestBuy = Math.max(...tokens.map((t) => t.kolBuyAt));
    const beforeTs = newestBuy + COPYTRADER_WINDOW_SECONDS;

    // Cada verificação custa ~1,1s, então a ORDEM importa: quem transferiu mais
    // tokens distintos (e mais valor) é o candidato mais promissor. Endereço já
    // no índice fura a fila — é o mais barato de confirmar.
    const score = (f: Finding) => {
      const tks = new Set(f.evidence.filter((e) => e.type === 'transfer').map((e) => e.tokenAddress));
      const usd = f.evidence.reduce((a, e) => a + (e.transferUsd ?? 0), 0);
      return (f.known ? 1e9 : 0) + tks.size * 1e6 + Math.min(usd, 1e5);
    };
    const candidates = Array.from(findings.values())
      .sort((a, b) => score(b) - score(a))
      .slice(0, MAX_CANDIDATES)
      .map((f) => f.address);
    const deadline = Date.now() + VERIFY_BUDGET_MS;
    let unverified = Math.max(0, findings.size - candidates.length);

    for (const address of candidates) {
      if (Date.now() > deadline) {
        unverified++;
        continue;
      }
      let swaps: Awaited<ReturnType<typeof this.candidateSwaps>>;
      try {
        swaps = await this.candidateSwaps(address, beforeTs);
        apiCalls++;
      } catch {
        unverified++;
        continue;
      }

      const self = findings.get(address);
      if (self) self.verified = true;

      // Carteira que negocia dezenas de tokens distintos numa janela curta é
      // infraestrutura (bot, roteador, saque de corretora), não sidewallet de
      // pessoa. Descarta antes de virar achado.
      const distinctMints = new Set(swaps.map((sw) => sw.mint)).size;
      if (distinctMints > INFRA_DISTINCT_MINTS) {
        findings.delete(address);
        continue;
      }

      for (const tok of tokens) {
        const mine = swaps.filter((s) => s.mint === tok.address);
        if (!mine.length) continue;
        // Negociou um token que o KOL também negociou — é isso que confirma um
        // endereço que ainda não está no índice.
        if (self) self.sharedTokens++;
        const buys = mine.filter((s) => s.side === 'BUY').map((s) => s.at);
        const sells = mine.filter((s) => s.side === 'SELL').map((s) => s.at);
        const firstBuyAt = buys.length ? Math.min(...buys) : null;
        const lastSellAt = sells.length ? Math.max(...sells) : null;

        // Comprou ANTES e saiu logo antes da carteira pública: quem sabia.
        if (firstBuyAt !== null && firstBuyAt < tok.kolBuyAt && lastSellAt !== null && tok.kolSellAt !== null) {
          const sellGap = tok.kolSellAt - lastSellAt;
          if (sellGap >= 0 && sellGap <= SELL_BEFORE_WINDOW_SECONDS) {
            const f = touch(address);
            if (f) {
              f.signals.add('early_buy_late_sell');
              f.evidence.push({
                type: 'early_buy_late_sell',
                token: tok.symbol,
                tokenAddress: tok.address,
                candidateBuyAt: firstBuyAt,
                candidateSellAt: lastSellAt,
                kolBuyAt: tok.kolBuyAt,
                kolSellAt: tok.kolSellAt,
                sellGapSeconds: sellGap,
              });
            }
          }
        }

        // Comprou DEPOIS, dentro da janela: copytrader, não sidewallet.
        if (firstBuyAt !== null && firstBuyAt > tok.kolBuyAt && firstBuyAt - tok.kolBuyAt <= COPYTRADER_WINDOW_SECONDS) {
          const f = touch(address);
          if (f) {
            f.signals.add('copytrade');
            f.evidence.push({
              type: 'copytrade',
              token: tok.symbol,
              tokenAddress: tok.address,
              candidateBuyAt: firstBuyAt,
              kolBuyAt: tok.kolBuyAt,
              deltaSeconds: firstBuyAt - tok.kolBuyAt,
            });
          }
        }
      }
    }

    // 5. classifica
    const buildEntry = (f: Finding, role: ScanFlagged['role'], confidence: ScanFlagged['confidence']): ScanFlagged => {
      const parts: string[] = [];
      const transferHit = f.evidence.find((e) => e.type === 'transfer');
      const patternHits = f.evidence.filter((e) => e.type === 'early_buy_late_sell');
      const copytradeHit = f.evidence.find((e) => e.type === 'copytrade');
      if (transferHit) parts.push(`Recebeu ${transferHit.token} (~$${transferHit.transferUsd.toFixed(0)}) direto da carteira pública, ou mandou pra ela — link direto on-chain.`);
      if (patternHits.length) {
        const toks = patternHits.map((e) => e.token).join(', ');
        parts.push(`Comprou antes e vendeu ${Math.round(patternHits[0].sellGapSeconds / 60) || '<1'} min antes da carteira pública em ${patternHits.length} token${patternHits.length > 1 ? 's diferentes' : ''} (${toks}) — padrão repetido, não coincidência isolada.`);
      }
      if (role === 'copytrader' && copytradeHit) {
        parts.push(`Comprou ${copytradeHit.token} ${Math.max(1, Math.round(copytradeHit.deltaSeconds / 60))} min DEPOIS da carteira pública — copytrader normal, não sidewallet.`);
      }
      if (!f.known && role === 'sidewallet') {
        parts.push(
          `Endereço NOVO — ainda não estava no índice. Confirmado por link direto mais atividade nos mesmos ${f.sharedTokens} token${f.sharedTokens === 1 ? '' : 's'} da carteira pública.`,
        );
      }
      if (f.recognizedElsewhere && role === 'sidewallet') {
        parts.push(`Aviso: esse endereço já está no índice como carteira de ${f.recognizedAs ?? 'outro KOL'} — pode ser um trader independente, não uma sidewallet.`);
      }
      if (!parts.length) parts.push('Sinal insuficiente.');
      return {
        address: f.address,
        name: f.name,
        ownerKolId: f.ownerKolId,
        ownerKolName: f.ownerKolName,
        role,
        confidence,
        recognizedElsewhere: f.recognizedElsewhere,
        recognizedAs: f.recognizedAs,
        signals: Array.from(f.signals),
        reason: parts.join(' '),
        evidence: f.evidence,
      };
    };

    const flagged: ScanFlagged[] = [];
    findings.forEach((f) => {
      const hasTransfer = f.signals.has('transfer');
      const patternTokens = new Set(
        f.evidence.filter((e) => e.type === 'early_buy_late_sell').map((e) => e.tokenAddress),
      ).size;
      const hasConfirmedPattern = patternTokens >= MIN_TOKENS_FOR_PATTERN;
      const onlyCopytrade = f.signals.size === 1 && f.signals.has('copytrade');

      if (onlyCopytrade) {
        flagged.push(buildEntry(f, 'copytrader', 'info'));
        return;
      }

      if (!f.known) {
        // DESCOBERTA: barra mais alta. Uma transferência sozinha pode ser
        // airdrop, saque de corretora ou envio aleatório — só vira achado com
        // atividade confirmada nos MESMOS tokens da carteira pública. Candidato
        // que não coube na verificação não entra: seria palpite, não evidência.
        if (!hasTransfer || !f.verified || f.sharedTokens === 0) return;
        const strong = hasConfirmedPattern || f.sharedTokens >= MIN_TOKENS_FOR_PATTERN;
        flagged.push(buildEntry(f, 'sidewallet', strong ? 'high' : 'medium'));
        return;
      }

      // Já no índice: o link direto sozinho basta (a identidade já é conhecida).
      if (!hasTransfer && !hasConfirmedPattern) return;
      if (!hasTransfer && hasConfirmedPattern && f.recognizedElsewhere) return;
      flagged.push(buildEntry(f, 'sidewallet', hasTransfer ? 'high' : 'medium'));
    });

    const roleOrder: Record<string, number> = { sidewallet: 0, copytrader: 1 };
    const confOrder: Record<string, number> = { high: 0, medium: 1, info: 2 };
    flagged.sort((a, b) => roleOrder[a.role] - roleOrder[b.role] || confOrder[a.confidence] - confOrder[b.confidence]);

    const sidewallets = flagged.filter((f) => f.role === 'sidewallet');
    const copytraders = flagged.filter((f) => f.role === 'copytrader');
    const linked = sidewallets.filter((f) => f.confidence === 'high').length;
    const discovered = flagged.filter((f) => !f.ownerKolId).length;
    const novos = discovered
      ? ` ${discovered} ${discovered === 1 ? 'endereço novo' : 'endereços novos'} (fora do índice) ${discovered === 1 ? 'foi descoberto' : 'foram descobertos'}.`
      : '';
    const partial =
      unverified > 0
        ? ` ${unverified} ${unverified === 1 ? 'candidato ficou' : 'candidatos ficaram'} sem verificação temporal (teto de candidatos ou orçamento de tempo) — o link direto deles continua valendo.`
        : '';
    const summary = `Analisou os últimos ${tokens.length} tokens de ${preset.name} contra as outras ${universe.size - ownAddrs.size} carteiras do índice: ${sidewallets.length} ${sidewallets.length === 1 ? 'sidewallet confirmada' : 'sidewallets confirmadas'} (${linked} com link direto on-chain, ${sidewallets.length - linked} por padrão comportamental repetido) e ${copytraders.length} ${copytraders.length === 1 ? 'copytrader identificado' : 'copytraders identificados'}. Coincidências de compra isolada (sem confirmação) foram descartadas.${novos}${partial}`;

    return this.persist({
      kolId,
      kolName: preset.name,
      scannedAt: Date.now(),
      status: 'complete',
      publicWallet: publicWallet.address,
      tokensAnalyzed: tokens.length,
      apiCalls,
      flagged,
      summary,
    });
  }
}
