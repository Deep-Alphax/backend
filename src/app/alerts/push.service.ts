import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import webpush, { WebPushError } from 'web-push';
import { PrismaService } from '../../prisma/prisma.service';

export interface PushPayload {
  title: string;
  body: string;
  /** Rota do site aberta ao clicar. Sempre relativa (o SW resolve na origem). */
  url: string;
  /** Agrupa no SO: a mesma tag substitui em vez de empilhar. */
  tag: string;
}

/** Tempo máximo esperando o serviço de push — nunca segurar o disparo. */
const PUSH_TIMEOUT_MS = 5_000;
/** O serviço guarda por até 1h se o aparelho estiver offline; alerta velho é ruído. */
const PUSH_TTL_SECONDS = 60 * 60;

/**
 * Web Push com VAPID (padrão aberto, sem serviço terceiro pago). Sem as chaves
 * no ambiente o push fica DESLIGADO e o resto (sininho, socket) segue
 * funcionando — degradação, não falha.
 *
 * Chaves: `npx web-push generate-vapid-keys` → `VAPID_PUBLIC_KEY`,
 * `VAPID_PRIVATE_KEY` e `VAPID_SUBJECT` (mailto: ou URL do site). A privada é
 * segredo: vive só no ambiente do backend.
 */
@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger(PushService.name);
  private publicKey: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const pub = this.config.get<string>('VAPID_PUBLIC_KEY');
    const priv = this.config.get<string>('VAPID_PRIVATE_KEY');
    const subject =
      this.config.get<string>('VAPID_SUBJECT') ??
      'mailto:support@deepalpha.fun';
    if (!pub || !priv) {
      this.logger.warn('VAPID_* ausente — Web Push desligado neste ambiente.');
      return;
    }
    try {
      webpush.setVapidDetails(subject, pub, priv);
      this.publicKey = pub;
    } catch (err) {
      this.logger.error(
        `VAPID inválido — Web Push desligado: ${(err as Error).message}`,
      );
    }
  }

  /** Chave pública para o navegador assinar a inscrição. `null` = push desligado. */
  get vapidPublicKey(): string | null {
    return this.publicKey;
  }

  /**
   * Envia para TODOS os navegadores do usuário. Nunca lança: push é acessório
   * do alerta (a notificação já está gravada e foi pelo socket).
   *
   * Inscrição que o serviço declara morta (404/410) é apagada — senão cada
   * alerta pagaria uma requisição perdida por aparelho desinstalado.
   */
  async sendToUser(userId: string, payload: PushPayload): Promise<void> {
    if (!this.publicKey) return;
    const subs = await this.prisma.getReadClient().pushSubscription.findMany({
      where: { userId },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    });
    if (subs.length === 0) return;

    const body = JSON.stringify(payload);
    const dead: string[] = [];
    const delivered: string[] = [];

    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            body,
            {
              TTL: PUSH_TTL_SECONDS,
              timeout: PUSH_TIMEOUT_MS,
              urgency: 'high',
            },
          );
          delivered.push(s.id);
        } catch (err) {
          const status = err instanceof WebPushError ? err.statusCode : 0;
          if (status === 404 || status === 410) {
            dead.push(s.id);
          } else {
            // Sem o endpoint no log: ele identifica o aparelho do usuário.
            this.logger.warn(
              `Push falhou (status ${status || 'rede'}) para ${userId}`,
            );
          }
        }
      }),
    );

    const write = this.prisma.getWriteClient();
    await Promise.all([
      dead.length
        ? write.pushSubscription.deleteMany({ where: { id: { in: dead } } })
        : null,
      delivered.length
        ? write.pushSubscription.updateMany({
            where: { id: { in: delivered } },
            data: { lastUsedAt: new Date() },
          })
        : null,
    ]).catch((err) =>
      this.logger.warn(
        `Manutenção das inscrições falhou: ${(err as Error).message}`,
      ),
    );
  }
}
