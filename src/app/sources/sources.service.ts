import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  Logger,
  Optional,
} from '@nestjs/common';
import { Prisma, MetricPeriod, SyncStatus, WalletKind } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CandleService } from '../analytics/candle.service';
import { CandlePoint } from '../analytics/profile-metrics.types';
import { normalizeWalletAddress } from '../wallets/wallet-address.util';
import {
  CreateSourceDto,
  UpdateSourceDto,
  AddSourceWalletDto,
} from './dto/source.dto';
import { attributeBuys, UserBuy, LeadBuy } from './source-attribution';
import {
  computeSourceBreakdown,
  SourceBreakdown,
  SourceTradeInput,
} from './source-metrics';

/** Dias de janela por período (espelha AnalyticsService). */
const PERIOD_DAYS: Record<MetricPeriod, number> = {
  [MetricPeriod.D30]: 30,
  [MetricPeriod.D90]: 90,
  [MetricPeriod.M12]: 365,
};

/** Projeção pública de uma fonte (com suas carteiras). */
const SOURCE_SELECT = {
  id: true,
  name: true,
  isActive: true,
  attributionWindowHours: true,
  createdAt: true,
  updatedAt: true,
  wallets: {
    select: {
      id: true,
      chain: true,
      chainType: true,
      address: true,
      label: true,
      syncStatus: true,
      lastSyncedAt: true,
      firstTxAt: true,
    },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.SourceSelect;

@Injectable()
export class SourcesService {
  private readonly logger = new Logger(SourcesService.name);

  /** Tetos anti-abuso/custo (cada carteira de fonte é sincronizada pelo provider). */
  private static readonly MAX_SOURCES_PER_USER = 30;
  private static readonly MAX_WALLETS_PER_SOURCE = 10;
  /** Teto de tokens consultados para capture por request (contém custo/rate-limit). */
  private static readonly MAX_CAPTURE_TOKENS = 40;

  constructor(
    private readonly prisma: PrismaService,
    // Capture (Bloco 2) é OPCIONAL: sem candles, o breakdown vem com capture=null.
    @Optional() private readonly candles?: CandleService,
  ) {}

  // ─────────────────────────────── CRUD de fontes ───────────────────────────────

  async create(userId: string, dto: CreateSourceDto) {
    const write = this.prisma.getWriteClient();

    const count = await write.source.count({ where: { userId } });
    if (count >= SourcesService.MAX_SOURCES_PER_USER) {
      throw new BadRequestException(
        `Limite de ${SourcesService.MAX_SOURCES_PER_USER} fontes por conta atingido.`,
      );
    }

    try {
      return await write.source.create({
        data: {
          userId,
          name: dto.name.trim(),
          ...(dto.attributionWindowHours !== undefined
            ? { attributionWindowHours: dto.attributionWindowHours }
            : {}),
        },
        select: SOURCE_SELECT,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Você já tem uma fonte com esse nome.');
      }
      throw error;
    }
  }

  findAll(userId: string) {
    return this.prisma.getReadClient().source.findMany({
      where: { userId },
      select: SOURCE_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(userId: string, id: string) {
    const source = await this.prisma.getReadClient().source.findFirst({
      where: { id, userId }, // ownership
      select: SOURCE_SELECT,
    });
    if (!source) throw new NotFoundException('Fonte não encontrada');
    return source;
  }

  async update(userId: string, id: string, dto: UpdateSourceDto) {
    await this.assertSourceOwnership(userId, id);
    try {
      const updated = await this.prisma.getWriteClient().source.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          ...(dto.attributionWindowHours !== undefined
            ? { attributionWindowHours: dto.attributionWindowHours }
            : {}),
        },
        select: SOURCE_SELECT,
      });
      // Mudança de janela/atividade/nome altera a atribuição → recomputa.
      await this.reattributeUser(userId);
      return updated;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Você já tem uma fonte com esse nome.');
      }
      throw error;
    }
  }

  async remove(userId: string, id: string) {
    await this.assertSourceOwnership(userId, id);
    // Cascade remove carteiras (kind=SOURCE) e atribuições vinculadas.
    await this.prisma.getWriteClient().source.delete({ where: { id } });
    return { success: true, message: 'Fonte removida.' };
  }

  // ──────────────────────────── Carteiras da fonte ────────────────────────────

  async addWallet(userId: string, sourceId: string, dto: AddSourceWalletDto) {
    await this.assertSourceOwnership(userId, sourceId);

    let normalized;
    try {
      normalized = normalizeWalletAddress(dto.chain, dto.address);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }

    const write = this.prisma.getWriteClient();
    const count = await write.wallet.count({ where: { sourceId } });
    if (count >= SourcesService.MAX_WALLETS_PER_SOURCE) {
      throw new BadRequestException(
        `Limite de ${SourcesService.MAX_WALLETS_PER_SOURCE} carteiras por fonte atingido.`,
      );
    }

    try {
      const wallet = await write.wallet.create({
        data: {
          userId,
          kind: WalletKind.SOURCE,
          sourceId,
          chain: dto.chain,
          chainType: normalized.chainType,
          address: normalized.address,
          addressNorm: normalized.addressNorm,
          label: dto.label?.trim() || null,
          syncStatus: SyncStatus.PENDING, // o cron de ingestão a drena e sincroniza
        },
        select: {
          id: true,
          chain: true,
          chainType: true,
          address: true,
          label: true,
          syncStatus: true,
        },
      });
      return wallet;
    } catch (error) {
      // Unique (userId, chain, addressNorm): a carteira já existe (própria ou de outra fonte).
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Esta carteira já está cadastrada nesta rede.',
        );
      }
      throw error;
    }
  }

  async removeWallet(userId: string, sourceId: string, walletId: string) {
    await this.assertSourceOwnership(userId, sourceId);
    const write = this.prisma.getWriteClient();
    const owned = await write.wallet.findFirst({
      where: { id: walletId, sourceId, kind: WalletKind.SOURCE },
      select: { id: true },
    });
    if (!owned) throw new NotFoundException('Carteira da fonte não encontrada');

    // Cascade remove os trades da carteira; recomputa a atribuição sem esses leads.
    await write.wallet.delete({ where: { id: walletId } });
    await this.reattributeUser(userId);
    return { success: true, message: 'Carteira da fonte removida.' };
  }

  // ─────────────────────────── Atribuição (lead-lag) ───────────────────────────

  /**
   * Recomputa TODAS as atribuições do usuário (delete + recreate). Idempotente.
   * Chamada em mudanças de config (fonte/carteira) e a cada sync de carteira
   * (nova compra do usuário ou nova compra de fonte muda o casamento).
   */
  async reattributeUser(userId: string): Promise<void> {
    const read = this.prisma.getReadClient();

    const sources = await read.source.findMany({
      where: { userId },
      select: { id: true, isActive: true, attributionWindowHours: true },
    });
    const allSourceIds = sources.map((s) => s.id);
    if (allSourceIds.length === 0) return; // nada a atribuir

    // Janela só das fontes ATIVAS (attributeBuys ignora fonte fora do mapa).
    const windowHoursBySource = new Map<string, number>(
      sources
        .filter((s) => s.isActive)
        .map((s) => [s.id, s.attributionWindowHours]),
    );

    const [leadRows, buyRows] = await Promise.all([
      read.trade.findMany({
        where: {
          side: 'BUY',
          wallet: {
            userId,
            kind: WalletKind.SOURCE,
            sourceId: { in: allSourceIds },
          },
        },
        select: {
          id: true,
          baseMint: true,
          blockTime: true,
          walletId: true,
          wallet: { select: { chain: true, sourceId: true } },
        },
      }),
      read.trade.findMany({
        where: { side: 'BUY', wallet: { userId, kind: WalletKind.OWN } },
        select: {
          id: true,
          baseMint: true,
          blockTime: true,
          wallet: { select: { chain: true } },
        },
      }),
    ]);

    const leadBuys: LeadBuy[] = leadRows
      .filter((r) => r.wallet.sourceId != null)
      .map((r) => ({
        tradeId: r.id,
        walletId: r.walletId,
        sourceId: r.wallet.sourceId as string,
        mint: r.baseMint,
        chain: r.wallet.chain,
        blockTimeMs: r.blockTime.getTime(),
      }));
    const userBuys: UserBuy[] = buyRows.map((r) => ({
      tradeId: r.id,
      mint: r.baseMint,
      chain: r.wallet.chain,
      blockTimeMs: r.blockTime.getTime(),
    }));

    const attributions = attributeBuys(userBuys, leadBuys, windowHoursBySource);

    const write = this.prisma.getWriteClient();
    await write.$transaction(async (tx) => {
      await tx.tradeAttribution.deleteMany({
        where: { sourceId: { in: allSourceIds } },
      });
      if (attributions.length > 0) {
        await tx.tradeAttribution.createMany({
          data: attributions.map((a) => ({
            tradeId: a.tradeId,
            sourceId: a.sourceId,
            leadTradeId: a.leadTradeId,
            leadWalletId: a.leadWalletId,
            lagSeconds: a.lagSeconds,
          })),
          skipDuplicates: true,
        });
      }
    });

    this.logger.log(
      `Reatribuição p/ user ${userId}: ${attributions.length} atribuições ` +
        `(${userBuys.length} compras × ${leadBuys.length} leads).`,
    );
  }

  // ──────────────────────────── Agregação (endpoint) ────────────────────────────

  /**
   * Breakdown "De onde vieram os trades" por fonte. Lê as atribuições persistidas
   * (mantidas frescas pelo sync/config) + os trades OWN do usuário e agrega.
   */
  async getSourcesAnalytics(
    userId: string,
    period: MetricPeriod,
  ): Promise<SourceBreakdown[]> {
    const read = this.prisma.getReadClient();

    const sources = await read.source.findMany({
      where: { userId, isActive: true },
      select: { id: true, name: true },
      orderBy: { createdAt: 'asc' },
    });
    if (sources.length === 0) return []; // sem fontes → tab vazia (empty state)

    const sourceIds = sources.map((s) => s.id);
    const attribs = await read.tradeAttribution.findMany({
      where: { sourceId: { in: sourceIds } },
      select: { tradeId: true, sourceId: true },
    });
    const attributionByBuyTradeId = new Map<string, string[]>();
    for (const a of attribs) {
      const arr = attributionByBuyTradeId.get(a.tradeId);
      if (arr) arr.push(a.sourceId);
      else attributionByBuyTradeId.set(a.tradeId, [a.sourceId]);
    }

    const rows = await read.trade.findMany({
      where: { wallet: { userId, kind: WalletKind.OWN } },
      select: {
        id: true,
        baseMint: true,
        baseSymbol: true,
        side: true,
        blockTime: true,
        baseAmount: true,
        priceUsd: true,
        chainType: true,
        wallet: { select: { chain: true } },
      },
      orderBy: { blockTime: 'asc' },
    });

    const userTrades: SourceTradeInput[] = rows.map((r) => ({
      id: r.id,
      mint: r.baseMint,
      symbol: r.baseSymbol,
      side: r.side,
      blockTimeMs: r.blockTime.getTime(),
      baseAmount: r.baseAmount.toString(),
      priceUsd: r.priceUsd.toString(),
    }));

    const windowStart = this.windowStart(period);

    // Capture (Bloco 2) é best-effort: falha/ausência de candles → undefined (capture null).
    const candlesByMint = await this.loadCaptureCandles(
      rows,
      attributionByBuyTradeId,
    ).catch((err) => {
      this.logger.warn(`Capture (candles) por fonte falhou: ${err?.message}`);
      return undefined;
    });

    return computeSourceBreakdown(
      userTrades,
      attributionByBuyTradeId,
      sources,
      { windowStart },
      candlesByMint,
    );
  }

  /**
   * Carrega candles (1h) dos tokens que têm compra atribuída, para o cálculo de
   * capture por fonte. Limitado a MAX_CAPTURE_TOKENS. Sem CandleService → undefined.
   */
  private async loadCaptureCandles(
    rows: Array<{
      id: string;
      baseMint: string;
      blockTime: Date;
      chainType: import('@prisma/client').ChainType;
      wallet: { chain: import('@prisma/client').Chain };
    }>,
    attributionByBuyTradeId: Map<string, string[]>,
  ): Promise<Map<string, CandlePoint[]> | undefined> {
    if (!this.candles) return undefined;

    // Tokens com ao menos uma COMPRA atribuída (só neles capture importa).
    const attributedMints = new Set<string>();
    for (const r of rows) {
      if (attributionByBuyTradeId.has(r.id)) attributedMints.add(r.baseMint);
    }
    if (attributedMints.size === 0) return undefined;

    // Janela de candles por mint = [primeiro trade, último trade] daquele token.
    const spanByMint = new Map<
      string,
      {
        chainType: import('@prisma/client').ChainType;
        chain: import('@prisma/client').Chain;
        from: number;
        to: number;
      }
    >();
    for (const r of rows) {
      if (!attributedMints.has(r.baseMint)) continue;
      const t = r.blockTime.getTime();
      const cur = spanByMint.get(r.baseMint);
      if (!cur) {
        spanByMint.set(r.baseMint, {
          chainType: r.chainType,
          chain: r.wallet.chain,
          from: t,
          to: t,
        });
      } else {
        cur.from = Math.min(cur.from, t);
        cur.to = Math.max(cur.to, t);
      }
    }

    const mints = [...spanByMint.keys()].slice(
      0,
      SourcesService.MAX_CAPTURE_TOKENS,
    );
    const out = new Map<string, CandlePoint[]>();
    for (const mint of mints) {
      const span = spanByMint.get(mint)!;
      const candles = await this.candles.getCandles(
        span.chainType,
        span.chain,
        mint,
        new Date(span.from),
        new Date(span.to),
        '1h',
      );
      if (candles.length > 0) {
        out.set(
          mint,
          candles.map((c) => ({ timeMs: c.timeMs, high: c.high })),
        );
      }
    }
    return out.size > 0 ? out : undefined;
  }

  // ─────────────────────────────── helpers ───────────────────────────────

  private windowStart(period: MetricPeriod): Date {
    const days = PERIOD_DAYS[period];
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  }

  /** Garante que a fonte existe E pertence ao usuário (evita IDOR). */
  private async assertSourceOwnership(
    userId: string,
    id: string,
  ): Promise<void> {
    const owned = await this.prisma.getReadClient().source.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!owned) throw new NotFoundException('Fonte não encontrada');
  }
}
