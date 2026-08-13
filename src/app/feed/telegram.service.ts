import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

export interface TelegramSendResult {
  ok: boolean;
  error?: string;
}

/**
 * Push de mensagens para o Telegram (Bot API `sendMessage`, HTML). O token do bot
 * fica em env (`TELEGRAM_BOT_TOKEN`) — segredo, nunca em DB/log. Sem token, o envio
 * vira no-op (retorna erro descritivo) para não derrubar a captura.
 */
@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly token: string;

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
  ) {
    this.token = this.config.get<string>('TELEGRAM_BOT_TOKEN') ?? '';
  }

  get enabled(): boolean {
    return this.token.length > 0;
  }

  /** Envia `html` (parse_mode HTML) para `chatId`. Nunca lança — devolve o resultado. */
  async sendMessage(chatId: string, html: string): Promise<TelegramSendResult> {
    if (!this.enabled) {
      return { ok: false, error: 'TELEGRAM_BOT_TOKEN ausente' };
    }
    try {
      await firstValueFrom(
        this.http.post(
          `https://api.telegram.org/bot${this.token}/sendMessage`,
          {
            chat_id: chatId,
            text: html,
            parse_mode: 'HTML',
            disable_web_page_preview: false,
          },
          { timeout: 15000 },
        ),
      );
      return { ok: true };
    } catch (err: any) {
      const detail =
        err?.response?.data?.description ?? err?.message ?? 'erro desconhecido';
      this.logger.warn(`Falha ao enviar ao Telegram (${chatId}): ${detail}`);
      return { ok: false, error: String(detail).slice(0, 500) };
    }
  }
}
