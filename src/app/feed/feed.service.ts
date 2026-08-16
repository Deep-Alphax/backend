import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, CapturedMessage } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { FeedQueryDto } from './dto/monitor.dto';
import { extractCalls } from './ca-extract';

/** Emitido quando uma captura é persistida → gateway empurra ao feed em tempo real. */
export const FEED_CAPTURED_EVENT = 'feed.captured';

/** Dados de uma captura a persistir. */
export interface CaptureInput {
  monitorId?: string | null;
  guildName?: string | null;
  channelId: string;
  channelName?: string | null;
  authorTag?: string | null;
  authorId?: string | null;
  matchedPattern?: string | null;
  discordMessageId?: string | null;
  text: string;
  embed?: unknown; // JSON serializável dos embeds (ou null)
  links: string[];
  sentToTelegram: boolean;
  telegramError?: string | null;
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

/** Persistência e consulta do feed de capturas (mensagens do Discord). */
@Injectable()
export class FeedService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  async create(input: CaptureInput): Promise<CapturedMessage> {
    const created = await this.prisma.getWriteClient().capturedMessage.create({
      data: {
        monitorId: input.monitorId ?? null,
        guildName: input.guildName ?? null,
        channelId: input.channelId,
        channelName: input.channelName ?? null,
        authorTag: input.authorTag ?? null,
        authorId: input.authorId ?? null,
        matchedPattern: input.matchedPattern ?? null,
        discordMessageId: input.discordMessageId ?? null,
        text: input.text,
        embed:
          input.embed == null
            ? Prisma.JsonNull
            : (input.embed as Prisma.InputJsonValue),
        links: input.links,
        sentToTelegram: input.sentToTelegram,
        telegramError: input.telegramError ?? null,
      },
    });
    // Deriva as "calls" (CA/mint + ticker) para o cruzamento trade × call (fontes).
    const refs = extractCalls(input.text, input.links);
    if (refs.mints.length || refs.tickers.length) {
      await this.prisma.getWriteClient().messageCall.createMany({
        data: [
          ...refs.mints.map((r) => ({
            capturedMessageId: created.id,
            chainType: r.chainType,
            mint: r.mint,
            guildName: input.guildName ?? null,
            channelId: input.channelId,
            calledAt: created.createdAt,
          })),
          ...refs.tickers.map((t) => ({
            capturedMessageId: created.id,
            ticker: t,
            guildName: input.guildName ?? null,
            channelId: input.channelId,
            calledAt: created.createdAt,
          })),
        ],
      });
    }

    this.events.emit(FEED_CAPTURED_EVENT, created); // feed em tempo real (WS)
    return created;
  }

  /** Lista paginada (mais recentes primeiro) com filtros opcionais. */
  async list(query: FeedQueryDto): Promise<{
    items: CapturedMessage[];
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  }> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, query.limit ?? DEFAULT_LIMIT),
    );

    const where: Prisma.CapturedMessageWhereInput = {
      ...(query.channelId ? { channelId: query.channelId } : {}),
      ...(query.monitorId ? { monitorId: query.monitorId } : {}),
      ...(query.authorId ? { authorId: query.authorId } : {}),
      ...(query.authorTag ? { authorTag: query.authorTag } : {}),
      ...(query.search
        ? { text: { contains: query.search, mode: 'insensitive' } }
        : {}),
    };

    const read = this.prisma.getReadClient();
    const [items, total] = await Promise.all([
      read.capturedMessage.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      read.capturedMessage.count({ where }),
    ]);

    return { items, page, limit, total, totalPages: Math.ceil(total / limit) };
  }

  async getById(id: string): Promise<CapturedMessage> {
    const item = await this.prisma
      .getReadClient()
      .capturedMessage.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Captura não encontrada');
    return item;
  }

  /**
   * Estatísticas do perfil de um autor (identidade por `authorTag`, presente em
   * 100% das capturas): total de mensagens, tokens distintos citados (via
   * `MessageCall`, cada CA/mint OU ticker único) e a primeira captura (idade "no
   * radar"). Indexado por `[authorTag, createdAt]`.
   */
  async getAuthorStats(authorTag: string): Promise<{
    authorTag: string;
    messages: number;
    tokens: number;
    firstSeenAt: string | null;
  }> {
    const read = this.prisma.getReadClient();

    const [messages, first, tokenRows] = await Promise.all([
      read.capturedMessage.count({ where: { authorTag } }),
      read.capturedMessage.findFirst({
        where: { authorTag },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      // Tokens únicos = COALESCE(mint, ticker) distintos nas calls do autor.
      read.$queryRaw<{ tokens: bigint }[]>`
        SELECT COUNT(DISTINCT COALESCE(mc."mint", mc."ticker")) AS tokens
        FROM "MessageCall" mc
        JOIN "CapturedMessage" cm ON cm."id" = mc."capturedMessageId"
        WHERE cm."authorTag" = ${authorTag}
      `,
    ]);

    return {
      authorTag,
      messages,
      tokens: Number(tokenRows[0]?.tokens ?? 0),
      firstSeenAt: first?.createdAt.toISOString() ?? null,
    };
  }
}
