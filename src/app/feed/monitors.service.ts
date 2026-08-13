import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DiscordMonitor } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateMonitorDto, UpdateMonitorDto } from './dto/monitor.dto';

/** Emitido após qualquer mutação em monitores → o self-bot recarrega as regras ao vivo. */
export const MONITORS_CHANGED_EVENT = 'discord.monitors.changed';

/**
 * CRUD das regras de monitoramento (admin). Cada mutação emite
 * `discord.monitors.changed` para o `DiscordMonitorService` recarregar sem restart.
 */
@Injectable()
export class MonitorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  list(): Promise<DiscordMonitor[]> {
    return this.prisma.getReadClient().discordMonitor.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Só as regras ativas — consumidas pelo self-bot. */
  listActive(): Promise<DiscordMonitor[]> {
    return this.prisma.getReadClient().discordMonitor.findMany({
      where: { isActive: true },
    });
  }

  async create(dto: CreateMonitorDto): Promise<DiscordMonitor> {
    const channelId = dto.channelId?.trim() || null;
    const guildId = dto.guildId?.trim() || null;
    if (!channelId && !guildId) {
      throw new BadRequestException(
        'Informe channelId (canal) ou guildId (servidor)',
      );
    }
    const monitor = await this.prisma.getWriteClient().discordMonitor.create({
      data: {
        name: dto.name?.trim() || null,
        channelId,
        guildId,
        pattern: dto.pattern?.trim() || null, // vazio → null (espelha tudo)
        telegramChatId: dto.telegramChatId,
        waitForBotReply: dto.waitForBotReply ?? true,
        isActive: dto.isActive ?? true,
      },
    });
    this.events.emit(MONITORS_CHANGED_EVENT);
    return monitor;
  }

  async update(id: string, dto: UpdateMonitorDto): Promise<DiscordMonitor> {
    await this.getOrThrow(id);
    const monitor = await this.prisma.getWriteClient().discordMonitor.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() || null } : {}),
        ...(dto.channelId !== undefined
          ? { channelId: dto.channelId.trim() || null }
          : {}),
        ...(dto.guildId !== undefined
          ? { guildId: dto.guildId.trim() || null }
          : {}),
        ...(dto.pattern !== undefined
          ? { pattern: dto.pattern.trim() || null }
          : {}),
        ...(dto.telegramChatId !== undefined
          ? { telegramChatId: dto.telegramChatId }
          : {}),
        ...(dto.waitForBotReply !== undefined
          ? { waitForBotReply: dto.waitForBotReply }
          : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
    this.events.emit(MONITORS_CHANGED_EVENT);
    return monitor;
  }

  async remove(id: string): Promise<{ id: string }> {
    await this.getOrThrow(id);
    await this.prisma.getWriteClient().discordMonitor.delete({ where: { id } });
    this.events.emit(MONITORS_CHANGED_EVENT);
    return { id };
  }

  private async getOrThrow(id: string): Promise<DiscordMonitor> {
    const monitor = await this.prisma
      .getReadClient()
      .discordMonitor.findUnique({ where: { id } });
    if (!monitor) throw new NotFoundException('Monitor não encontrado');
    return monitor;
  }
}
