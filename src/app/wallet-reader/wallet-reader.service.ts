import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import KOL_PROFILES from './data/kol-profiles.json';
import SEED from './data/sidewallet-scans.seed.json';

const pexec = promisify(execFile);

const MIN_TRANSFER_USD = 3;
const MAX_TOKENS = 5;
const CALL_SPACING_MS = 400;
const COPYTRADER_WINDOW_SECONDS = 24 * 3600;
const SELL_BEFORE_WINDOW_SECONDS = 15 * 60;
const MIN_TOKENS_FOR_PATTERN = 2;

interface WalletRef {
  name: string;
  address: string;
}
interface Profile {
  id: string;
  name: string;
  wallets: WalletRef[];
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
export interface ScanResult {
  kolId: string;
  kolName: string;
  scannedAt: number;
  status: 'complete' | 'error';
  publicWallet: string;
  tokensAnalyzed: number;
  apiCalls: number;
  flagged: ScanFlagged[];
  summary: string;
}

interface Finding {
  address: string;
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
 * Usa dados on-chain reais via `gmgn-cli` (shell) — o binário precisa estar
 * instalado E autenticado no host do backend. Escopo: só as carteiras já no
 * índice (kol-profiles), não a Solana inteira. Resultados persistem em `WalletScan`.
 */
@Injectable()
export class WalletReaderService implements OnModuleInit {
  private readonly logger = new Logger(WalletReaderService.name);
  private readonly profiles = KOL_PROFILES as unknown as Profile[];

  constructor(private readonly prisma: PrismaService) {}

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
  }

  /** Todos os scans cacheados como { scans: { [kolId]: ScanResult } }. */
  async getScans(): Promise<{ scans: Record<string, ScanResult> }> {
    const rows = await this.prisma.getReadClient().walletScan.findMany();
    const scans: Record<string, ScanResult> = {};
    for (const r of rows) {
      scans[r.kolId] = {
        kolId: r.kolId,
        kolName: r.kolName,
        scannedAt: r.scannedAt.getTime(),
        status: r.status as ScanResult['status'],
        publicWallet: r.publicWallet,
        tokensAnalyzed: r.tokensAnalyzed,
        apiCalls: r.apiCalls,
        flagged: (r.flagged as unknown as ScanFlagged[]) ?? [],
        summary: r.summary,
      };
    }
    return { scans };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Chama o gmgn-cli e extrai o último JSON da saída. Respeita o rate limit. */
  private async gmgnRaw(args: string[]): Promise<any> {
    let stdout: string;
    try {
      ({ stdout } = await pexec('gmgn-cli', [...args, '--raw'], {
        maxBuffer: 1024 * 1024 * 50,
        timeout: 30000,
        shell: true,
      }));
    } catch (e: any) {
      // CLI ausente no host do backend → mensagem clara (não é rate limit).
      if (e?.code === 'ENOENT' || /not found|não encontrado|not recognized/i.test(e?.message ?? '')) {
        throw new Error('gmgn-cli não está instalado/autenticado no host do backend');
      }
      throw e;
    }
    await this.sleep(CALL_SPACING_MS);
    const lines = stdout.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('{') || line.startsWith('[')) {
        try {
          return JSON.parse(line);
        } catch {
          /* keep looking */
        }
      }
    }
    throw new Error('could not parse gmgn-cli output: ' + stdout.slice(0, 300));
  }

  private buildUniverse(): Map<string, { kolId: string; kolName: string; walletName: string }> {
    const map = new Map<string, { kolId: string; kolName: string; walletName: string }>();
    this.profiles.forEach((p) => {
      p.wallets.forEach((w) => map.set(w.address, { kolId: p.id, kolName: p.name, walletName: w.name }));
    });
    return map;
  }

  private isRecognizedElsewhere(trader: any): boolean {
    if (!trader) return false;
    if (trader.name) return true;
    if (trader.twitter_username) return true;
    const tags = trader.tags || [];
    return tags.includes('renowned') || tags.includes('smart_degen');
  }

  private async persist(result: ScanResult): Promise<ScanResult> {
    const data = {
      kolName: result.kolName,
      scannedAt: new Date(result.scannedAt),
      status: result.status,
      publicWallet: result.publicWallet,
      tokensAnalyzed: result.tokensAnalyzed,
      apiCalls: result.apiCalls,
      flagged: result.flagged as unknown as Prisma.InputJsonValue,
      summary: result.summary,
    };
    await this.prisma.getWriteClient().walletScan.upsert({
      where: { kolId: result.kolId },
      create: { kolId: result.kolId, ...data },
      update: data,
    });
    return result;
  }

  /** Roda a varredura de um KOL e persiste o resultado. */
  async scanKol(kolId: string): Promise<ScanResult> {
    const profile = this.profiles.find((p) => p.id === kolId);
    if (!profile) throw new NotFoundException('KOL not found: ' + kolId);
    if (!profile.wallets.length) throw new NotFoundException('KOL has no wallets: ' + kolId);

    const universe = this.buildUniverse();
    const ownAddrs = new Set(profile.wallets.map((w) => w.address));
    const publicWallet = profile.wallets[0];
    let apiCalls = 0;

    const fail = (message: string) =>
      this.persist({
        kolId,
        kolName: profile.name,
        scannedAt: Date.now(),
        status: 'error',
        publicWallet: publicWallet.address,
        tokensAnalyzed: 0,
        apiCalls,
        flagged: [],
        summary: `Varredura falhou: ${message}. Provável rate limit da GMGN — tente de novo em alguns minutos.`,
      });

    // 1. últimos 5 tokens comprados pela carteira pública
    let buyResp: any;
    try {
      buyResp = await this.gmgnRaw(['portfolio', 'activity', '--chain', 'sol', '--wallet', publicWallet.address, '--type', 'buy', '--limit', '30']);
      apiCalls++;
    } catch (e: any) {
      return fail(e.message);
    }

    const tokens: Array<{ address: string; symbol: string; kolBuyAt: number; kolSellAt: number | null }> = [];
    (buyResp.activities || []).forEach((a: any) => {
      if (!a.token?.address) return;
      if (tokens.some((t) => t.address === a.token.address)) return;
      if (tokens.length >= MAX_TOKENS) return;
      tokens.push({ address: a.token.address, symbol: a.token.symbol, kolBuyAt: a.timestamp, kolSellAt: null });
    });

    if (!tokens.length) {
      return this.persist({
        kolId,
        kolName: profile.name,
        scannedAt: Date.now(),
        status: 'complete',
        publicWallet: publicWallet.address,
        tokensAnalyzed: 0,
        apiCalls,
        flagged: [],
        summary: `A carteira pública de ${profile.name} não tem compras recentes registradas na GMGN — nada pra analisar.`,
      });
    }

    // 2. vendas da carteira pública nesses tokens (venda mais antiga = início da saída)
    try {
      const sellResp = await this.gmgnRaw(['portfolio', 'activity', '--chain', 'sol', '--wallet', publicWallet.address, '--type', 'sell', '--limit', '50']);
      apiCalls++;
      (sellResp.activities || []).forEach((a: any) => {
        if (!a.token) return;
        const tok = tokens.find((t) => t.address === a.token.address);
        if (!tok) return;
        if (tok.kolSellAt === null || a.timestamp < tok.kolSellAt) tok.kolSellAt = a.timestamp;
      });
    } catch {
      /* sem dados de venda */
    }

    const findings = new Map<string, Finding>();
    const touch = (address: string, trader: any): Finding | null => {
      if (ownAddrs.has(address)) return null;
      const known = universe.get(address);
      if (!known) return null;
      if (!findings.has(address)) {
        findings.set(address, {
          address,
          name: known.walletName,
          ownerKolId: known.kolId,
          ownerKolName: known.kolName,
          signals: new Set(),
          evidence: [],
          recognizedElsewhere: this.isRecognizedElsewhere(trader),
          recognizedAs: trader ? trader.name || trader.twitter_username || null : null,
        });
      } else if (trader && this.isRecognizedElsewhere(trader)) {
        const f = findings.get(address)!;
        f.recognizedElsewhere = true;
        f.recognizedAs = f.recognizedAs || trader.name || trader.twitter_username || null;
      }
      return findings.get(address)!;
    };

    // 3. transfers de entrada dos tokens, vindas de carteira rastreada (Cat. A)
    let publicFundingSource: string | null = null;
    try {
      const transferResp = await this.gmgnRaw(['portfolio', 'activity', '--chain', 'sol', '--wallet', publicWallet.address, '--type', 'transferIn', '--limit', '50']);
      apiCalls++;
      (transferResp.activities || []).forEach((a: any) => {
        const from = a.from_address;
        if (!from || !a.token) return;
        const tokenHit = tokens.find((t) => t.address === a.token.address);
        if (!tokenHit) return;
        const usd = parseFloat(a.cost_usd || 0);
        if (usd < MIN_TRANSFER_USD) return;
        const f = touch(from, null);
        if (!f) return;
        f.signals.add('transfer');
        f.evidence.push({ type: 'transfer', token: tokenHit.symbol, tokenAddress: tokenHit.address, transferUsd: usd, transferAt: a.timestamp, transferTx: a.tx_hash });
      });
    } catch {
      /* sem transfers */
    }

    // 4. por token: funding source + timing de compra/venda (Cat. A + B)
    for (const tok of tokens) {
      let resp: any;
      try {
        resp = await this.gmgnRaw(['token', 'traders', '--chain', 'sol', '--address', tok.address, '--limit', '100']);
        apiCalls++;
      } catch {
        continue;
      }
      (resp.list || []).forEach((t: any) => {
        if (!t.address) return;
        if (t.address === publicWallet.address) {
          if (t.native_transfer?.address) publicFundingSource = t.native_transfer.address;
          return;
        }
        if (ownAddrs.has(t.address)) return;
        const startAt = t.start_holding_at;
        const endAt = t.end_holding_at;

        if (t.native_transfer?.address && publicFundingSource && t.native_transfer.address === publicFundingSource) {
          const f = touch(t.address, t);
          if (f) {
            f.signals.add('shared_funding');
            f.evidence.push({ type: 'shared_funding', token: tok.symbol, tokenAddress: tok.address, fundingSource: publicFundingSource });
          }
        }

        if (typeof startAt === 'number' && startAt < tok.kolBuyAt && typeof endAt === 'number' && tok.kolSellAt !== null) {
          const sellGap = tok.kolSellAt - endAt;
          if (sellGap >= 0 && sellGap <= SELL_BEFORE_WINDOW_SECONDS) {
            const f = touch(t.address, t);
            if (f) {
              f.signals.add('early_buy_late_sell');
              f.evidence.push({ type: 'early_buy_late_sell', token: tok.symbol, tokenAddress: tok.address, candidateBuyAt: startAt, candidateSellAt: endAt, kolBuyAt: tok.kolBuyAt, kolSellAt: tok.kolSellAt, sellGapSeconds: sellGap });
            }
          }
        }

        if (typeof startAt === 'number' && startAt > tok.kolBuyAt && startAt - tok.kolBuyAt <= COPYTRADER_WINDOW_SECONDS) {
          const f = touch(t.address, t);
          if (f) {
            f.signals.add('copytrade');
            f.evidence.push({ type: 'copytrade', token: tok.symbol, tokenAddress: tok.address, candidateBuyAt: startAt, kolBuyAt: tok.kolBuyAt, deltaSeconds: startAt - tok.kolBuyAt });
          }
        }
      });
    }

    // 5. classifica
    const buildEntry = (f: Finding, role: ScanFlagged['role'], confidence: ScanFlagged['confidence']): ScanFlagged => {
      const parts: string[] = [];
      const transferHit = f.evidence.find((e) => e.type === 'transfer');
      const fundingHit = f.evidence.find((e) => e.type === 'shared_funding');
      const patternHits = f.evidence.filter((e) => e.type === 'early_buy_late_sell');
      const copytradeHit = f.evidence.find((e) => e.type === 'copytrade');
      if (transferHit) parts.push(`Recebeu ${transferHit.token} (~$${transferHit.transferUsd.toFixed(0)}) direto da carteira pública, ou mandou pra ela — link direto on-chain.`);
      if (fundingHit) parts.push(`Foi financiada pela MESMA origem de SOL que financiou a carteira pública — mesmo operador.`);
      if (patternHits.length) {
        const toks = patternHits.map((e) => e.token).join(', ');
        parts.push(`Comprou antes e vendeu ${Math.round(patternHits[0].sellGapSeconds / 60) || '<1'} min antes da carteira pública em ${patternHits.length} token${patternHits.length > 1 ? 's diferentes' : ''} (${toks}) — padrão repetido, não coincidência isolada.`);
      }
      if (role === 'copytrader' && copytradeHit) {
        parts.push(`Comprou ${copytradeHit.token} ${Math.max(1, Math.round(copytradeHit.deltaSeconds / 60))} min DEPOIS da carteira pública — copytrader normal, não sidewallet.`);
      }
      if (f.recognizedElsewhere && role === 'sidewallet') {
        parts.push(`Aviso: essa carteira já tem identidade própria reconhecida pela GMGN${f.recognizedAs ? ' (' + f.recognizedAs + ')' : ''} — pode ser um trader independente, não uma sidewallet.`);
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
      const hasSharedFunding = f.signals.has('shared_funding');
      const patternTokens = new Set(f.evidence.filter((e) => e.type === 'early_buy_late_sell').map((e) => e.tokenAddress)).size;
      const hasDirectLink = hasTransfer || hasSharedFunding;
      const hasConfirmedPattern = patternTokens >= MIN_TOKENS_FOR_PATTERN;
      const onlyCopytrade = f.signals.size === 1 && f.signals.has('copytrade');
      if (onlyCopytrade) {
        flagged.push(buildEntry(f, 'copytrader', 'info'));
        return;
      }
      if (!hasDirectLink && !hasConfirmedPattern) return;
      if (!hasDirectLink && hasConfirmedPattern && f.recognizedElsewhere) return;
      flagged.push(buildEntry(f, 'sidewallet', hasDirectLink ? 'high' : 'medium'));
    });

    const roleOrder: Record<string, number> = { sidewallet: 0, copytrader: 1 };
    const confOrder: Record<string, number> = { high: 0, medium: 1, info: 2 };
    flagged.sort((a, b) => roleOrder[a.role] - roleOrder[b.role] || confOrder[a.confidence] - confOrder[b.confidence]);

    const sidewallets = flagged.filter((f) => f.role === 'sidewallet');
    const copytraders = flagged.filter((f) => f.role === 'copytrader');
    const linked = sidewallets.filter((f) => f.confidence === 'high').length;
    const summary = `Analisou os últimos ${tokens.length} tokens de ${profile.name} contra as outras ${universe.size - ownAddrs.size} carteiras do índice: ${sidewallets.length} ${sidewallets.length === 1 ? 'sidewallet confirmada' : 'sidewallets confirmadas'} (${linked} com link direto on-chain, ${sidewallets.length - linked} por padrão comportamental repetido) e ${copytraders.length} ${copytraders.length === 1 ? 'copytrader identificado' : 'copytraders identificados'}. Coincidências de compra isolada (sem confirmação) foram descartadas.`;

    return this.persist({
      kolId,
      kolName: profile.name,
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
