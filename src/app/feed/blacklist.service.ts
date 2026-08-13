import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BlacklistedUser } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateBlacklistDto, UpdateBlacklistDto } from './dto/blacklist.dto';

/** Emitido após mutação na blacklist → o self-bot recarrega ao vivo. */
export const BLACKLIST_CHANGED_EVENT = 'discord.blacklist.changed';

/** CRUD da blacklist de usuários do Discord (admin). Global (vale p/ todas as regras). */
@Injectable()
export class BlacklistService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  list(): Promise<BlacklistedUser[]> {
    return this.prisma.getReadClient().blacklistedUser.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  listActive(): Promise<BlacklistedUser[]> {
    return this.prisma.getReadClient().blacklistedUser.findMany({
      where: { isActive: true },
    });
  }

  async create(dto: CreateBlacklistDto): Promise<BlacklistedUser> {
    const discordUserId = dto.discordUserId?.trim() || null;
    const username = dto.username?.trim() || null;
    if (!discordUserId && !username) {
      throw new BadRequestException('Informe discordUserId ou username');
    }
    const entry = await this.prisma.getWriteClient().blacklistedUser.create({
      data: {
        discordUserId,
        username,
        reason: dto.reason?.trim() || null,
        isActive: dto.isActive ?? true,
      },
    });
    this.events.emit(BLACKLIST_CHANGED_EVENT);
    return entry;
  }

  async update(id: string, dto: UpdateBlacklistDto): Promise<BlacklistedUser> {
    await this.getOrThrow(id);
    const entry = await this.prisma.getWriteClient().blacklistedUser.update({
      where: { id },
      data: {
        ...(dto.discordUserId !== undefined
          ? { discordUserId: dto.discordUserId.trim() || null }
          : {}),
        ...(dto.username !== undefined
          ? { username: dto.username.trim() || null }
          : {}),
        ...(dto.reason !== undefined
          ? { reason: dto.reason.trim() || null }
          : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
    this.events.emit(BLACKLIST_CHANGED_EVENT);
    return entry;
  }

  async remove(id: string): Promise<{ id: string }> {
    await this.getOrThrow(id);
    await this.prisma
      .getWriteClient()
      .blacklistedUser.delete({ where: { id } });
    this.events.emit(BLACKLIST_CHANGED_EVENT);
    return { id };
  }

  private async getOrThrow(id: string): Promise<BlacklistedUser> {
    const entry = await this.prisma
      .getReadClient()
      .blacklistedUser.findUnique({ where: { id } });
    if (!entry) throw new NotFoundException('Entrada não encontrada');
    return entry;
  }
}
