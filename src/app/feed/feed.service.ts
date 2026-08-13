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
}
