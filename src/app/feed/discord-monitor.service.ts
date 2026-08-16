import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { DiscordMonitor } from '@prisma/client';
import { MonitorsService, MONITORS_CHANGED_EVENT } from './monitors.service';
import { BlacklistService, BLACKLIST_CHANGED_EVENT } from './blacklist.service';
import { FeedService } from './feed.service';
import { TelegramService } from './telegram.service';
import {
  extractAllText,
  extractLinks,
  formatForTelegram,
  isKnownBot,
  matchPattern,
  type MessageLike,
  type OriginLike,
} from './signal-format.util';

// Lib de self-bot (não-oficial, sem types). `require` evita erro de resolução de tipos.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Client } = require('discord.js-selfbot-v13');

/** Discriminators de bots conhecidos (Rick etc.) que "falam sozinhos". */
const KNOWN_BOT_IDS = ['9725', '8106', '1547', '8649', '9822'] as const;

/** Espera pela resposta do bot com dados ricos após um match. */
const BOT_REPLY_WAIT_MS = 1500;

/**
 * Cliente self-bot do Discord: observa os canais das regras ATIVAS (carregadas do
 * banco via MonitorsService, recarregadas ao vivo quando o admin muda o CRUD),
 * casa o padrão, opcionalmente captura a resposta rica do bot, persiste a captura
 * (FeedService) e empurra ao Telegram (TelegramService).
 *
 * SEGURANÇA/ToS: self-bot viola o ToS do Discord (risco de ban da conta). Todo o
 * ciclo é guardado (try/catch) e o serviço é INERTE sem `DISCORD_USER_TOKEN` — a
 * ausência do token nunca derruba o boot da API.
 */
@Injectable()
export class DiscordMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DiscordMonitorService.name);
  private client: any = null;
  private ready = false;
  private userTag: string | null = null;

  /** Regras ativas indexadas por canal e por servidor (match rápido no messageCreate). */
  private monitorsByChannel = new Map<string, DiscordMonitor[]>();
  private monitorsByGuild = new Map<string, DiscordMonitor[]>();

  /** Blacklist ativa: IDs exatos + trechos de username (lowercase). */
  private blacklistIds = new Set<string>();
  private blacklistNames: string[] = [];

  constructor(
    private readonly config: ConfigService,
    private readonly monitors: MonitorsService,
    private readonly blacklist: BlacklistService,
    private readonly feed: FeedService,
    private readonly telegram: TelegramService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refreshMonitors();
    await this.refreshBlacklist();

    const token = this.config.get<string>('DISCORD_USER_TOKEN');
    if (!token) {
      this.logger.warn(
        'DISCORD_USER_TOKEN ausente → self-bot DESLIGADO (CRUD e feed seguem funcionando).',
      );
      return;
    }

    try {
      this.client = new Client({ checkUpdate: false });
      this.client.on('ready', () => {
        this.ready = true;
        this.userTag = this.client?.user?.tag ?? null;
        this.logger.log(`Self-bot logado como ${this.userTag}`);
      });
      this.client.on('messageCreate', (msg: any) => {
        this.handleMessage(msg).catch((err) =>
          this.logger.debug(`Erro ao processar mensagem: ${err?.message}`),
        );
      });
      this.client.on('error', (err: any) =>
        this.logger.warn(`Discord error: ${err?.message}`),
      );

      await this.client.login(token);
    } catch (err: any) {
      // Nunca derruba o boot por causa do self-bot.
      this.logger.error(`Falha ao iniciar o self-bot: ${err?.message}`);
      this.client = null;
      this.ready = false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.client?.destroy?.();
    } catch {
      /* ignore */
    }
  }

  /** Recarrega as regras ativas do banco (chamado no boot e quando o CRUD muda). */
  @OnEvent(MONITORS_CHANGED_EVENT)
  async refreshMonitors(): Promise<void> {
    try {
      const active = await this.monitors.listActive();
      const byChannel = new Map<string, DiscordMonitor[]>();
      const byGuild = new Map<string, DiscordMonitor[]>();
      for (const m of active) {
        // channelId tem prioridade; senão, guildId (servidor inteiro).
        if (m.channelId) {
          const list = byChannel.get(m.channelId) ?? [];
          list.push(m);
          byChannel.set(m.channelId, list);
        } else if (m.guildId) {
          const list = byGuild.get(m.guildId) ?? [];
          list.push(m);
          byGuild.set(m.guildId, list);
        }
      }
      this.monitorsByChannel = byChannel;
      this.monitorsByGuild = byGuild;
      this.logger.log(
        `Regras ativas recarregadas: ${active.length} (${byChannel.size} canais, ${byGuild.size} servidores).`,
      );
    } catch (err: any) {
      this.logger.error(`Falha ao recarregar regras: ${err?.message}`);
    }
  }

  /** Recarrega a blacklist ativa (boot + evento de mudança). */
  @OnEvent(BLACKLIST_CHANGED_EVENT)
  async refreshBlacklist(): Promise<void> {
    try {
      const active = await this.blacklist.listActive();
      this.blacklistIds = new Set(
        active.map((b) => b.discordUserId).filter((v): v is string => !!v),
      );
      this.blacklistNames = active
        .map((b) => b.username?.toLowerCase())
        .filter((v): v is string => !!v);
      this.logger.log(`Blacklist recarregada: ${active.length} usuário(s).`);
    } catch (err: any) {
      this.logger.error(`Falha ao recarregar blacklist: ${err?.message}`);
    }
  }

  /** True se o autor está na blacklist (por ID exato ou trecho de username/tag). */
  private isBlacklisted(message: any): boolean {
    const id = String(message.author?.id ?? '');
    if (id && this.blacklistIds.has(id)) return true;
    if (this.blacklistNames.length === 0) return false;
    const uname = String(message.author?.username ?? '').toLowerCase();
    const tag = String(message.author?.tag ?? '').toLowerCase();
    return this.blacklistNames.some(
      (n) => uname.includes(n) || tag.includes(n),
    );
  }

  /** Status para o endpoint de admin. */
  getStatus() {
    return {
      enabled: !!this.config.get<string>('DISCORD_USER_TOKEN'),
      connected: this.ready,
      userTag: this.userTag,
      telegramEnabled: this.telegram.enabled,
      activeMonitors: [
        ...this.monitorsByChannel.values(),
        ...this.monitorsByGuild.values(),
      ].reduce((a, l) => a + l.length, 0),
      watchedChannels: this.monitorsByChannel.size,
      watchedGuilds: this.monitorsByGuild.size,
    };
  }

  // ─────────────────────────── Handler ───────────────────────────

  /** Bot "falando sozinho" (é bot e NÃO é resposta). No modo filtro, é ignorado. */
  private isLooseBot(message: any): boolean {
    const tag = message.author?.tag ?? '';
    if (message.author?.bot || isKnownBot(tag, KNOWN_BOT_IDS)) {
      return !message.reference;
    }
    return false;
  }

  private async handleMessage(message: any): Promise<void> {
    if (!message?.channel?.id) return;
    if (message.author?.id === this.client?.user?.id) return; // nunca as próprias
    if (this.isBlacklisted(message)) return; // autor em blacklist → ignora

    // Regras do canal específico + regras do servidor inteiro (guildId).
    const channelMonitors =
      this.monitorsByChannel.get(String(message.channel.id)) ?? [];
    const guildMonitors = message.guild?.id
      ? (this.monitorsByGuild.get(String(message.guild.id)) ?? [])
      : [];
    const monitors = [...channelMonitors, ...guildMonitors];
    if (!monitors.length) return;

    const fullText = extractAllText(message as MessageLike);
    const looseBot = this.isLooseBot(message);

    for (const monitor of monitors) {
      // Sem padrão → ESPELHO: encaminha TODA mensagem (inclusive de bots), sem
      // enriquecer. Com padrão → FILTRO: ignora bot solto, casa o padrão e (opcional)
      // captura a resposta rica do bot.
      const mirror = !monitor.pattern || monitor.pattern.trim() === '';

      if (mirror) {
        await this.capture(monitor, message, message);
        break;
      }

      if (looseBot) continue;
      if (!matchPattern(fullText, monitor.pattern ?? '')) continue;

      const target = monitor.waitForBotReply
        ? await this.tryFetchBotReply(message)
        : message;
      await this.capture(monitor, message, target);
      break;
    }
  }

  /** Persiste a captura e empurra ao Telegram (uma regra). */
  private async capture(
    monitor: DiscordMonitor,
    message: any,
    target: any,
  ): Promise<void> {
    const origin: OriginLike = {
      authorTag: message.author?.tag ?? 'unknown',
      channelId: String(message.channel?.id ?? ''),
      channelName: message.channel?.name ?? '',
      guildName: message.guild?.name ?? null,
    };

    const text = extractAllText(target as MessageLike);
    const links = extractLinks(text);
    const embed = this.serializeEmbeds(target);
    const html = formatForTelegram(target as MessageLike, origin);

    const sent = await this.telegram.sendMessage(monitor.telegramChatId, html);

    try {
      await this.feed.create({
        monitorId: monitor.id,
        guildName: origin.guildName,
        channelId: origin.channelId,
        channelName: origin.channelName,
        authorTag: origin.authorTag,
        authorId: message.author?.id ? String(message.author.id) : null,
        matchedPattern: monitor.pattern,
        discordMessageId: String(target?.id ?? message.id ?? ''),
        text,
        embed,
        links,
        sentToTelegram: sent.ok,
        telegramError: sent.ok ? null : sent.error,
      });
    } catch (err: any) {
      this.logger.error(`Falha ao persistir captura: ${err?.message}`);
    }

    this.logger.log(
      `Captura [canal ${origin.channelId}] "${monitor.name ?? monitor.pattern ?? 'espelho'}" → Telegram ${sent.ok ? 'OK' : 'FALHOU'}`,
    );
  }

  /** Aguarda ~1.5s e tenta achar a resposta de bot à mensagem; senão, a própria. */
  private async tryFetchBotReply(message: any): Promise<any> {
    try {
      await new Promise((r) => setTimeout(r, BOT_REPLY_WAIT_MS));
      const fetched = await message.channel.messages.fetch({ limit: 5 });
      const reply = fetched.find(
        (m: any) =>
          m.reference?.messageId === message.id &&
          (m.author?.bot || isKnownBot(m.author?.tag ?? '', KNOWN_BOT_IDS)),
      );
      return reply ?? message;
    } catch {
      return message;
    }
  }

  /** Embeds → JSON plano (serializável) para persistir e render rico no site. */
  private serializeEmbeds(message: any): Record<string, unknown>[] | null {
    const embeds = message?.embeds;
    if (!Array.isArray(embeds) || embeds.length === 0) return null;
    return embeds.map((e: any) => {
      if (typeof e?.toJSON === 'function') return e.toJSON();
      return {
        title: e?.title ?? null,
        description: e?.description ?? null,
        fields: e?.fields ?? null,
        footer: e?.footer ?? null,
        author: e?.author ?? null,
        url: e?.url ?? null,
      };
    });
  }
}
