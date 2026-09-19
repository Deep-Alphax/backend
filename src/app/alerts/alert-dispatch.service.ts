import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AlertKind, CapturedMessage, Plan } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EntitlementsService } from '../billing/entitlements.service';
import { FEED_CAPTURED_EVENT } from '../feed/feed.service';
import { FeedAccessService } from '../feed/feed-access.service';
import { matchCapture, type RuleForMatch } from './alert-match';
import { PushService } from './push.service';

/** Emitido por notificação criada → o gateway empurra ao sininho do dono. */
export const NOTIFICATION_CREATED_EVENT = 'alerts.notification-created';

export interface NotificationCreatedEvent {
  userId: string;
  notification: {
    id: string;
    title: string;
    body: string;
    capturedMessageId: string;
    createdAt: Date;
  };
}

/** Notificação mais velha que isto é apagada (o sininho não é arquivo). */
const RETENTION_DAYS = 30;

/**
 * Captura nova → regras que casam → notificação (banco + socket + push).
 *
 * Roda FORA do caminho da captura (`async: true`): o self-bot do Discord não
 * espera alerta nenhum, e uma falha aqui nunca derruba a captura.
 *
 * Custo por captura, independente do número de usuários:
 *  - 1 query de regras de AUTOR/CANAL (índice `kind, value, isActive`);
 *  - 1 query de TERMOS, com o `strpos` feito no Postgres — só as regras que
 *    casam trafegam, não a tabela inteira;
 *  - 1 query de planos (`plansFor`) + 1 de "regra vigente" dos FREE;
 *  - 1 `createManyAndReturn` para todas as notificações.
 */
@Injectable()
export class AlertDispatchService {
  private readonly logger = new Logger(AlertDispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly feedAccess: FeedAccessService,
    private readonly push: PushService,
    private readonly events: EventEmitter2,
  ) {}

  @OnEvent(FEED_CAPTURED_EVENT, { async: true })
  async onCapture(capture: CapturedMessage): Promise<void> {
    try {
      await this.dispatch(capture);
    } catch (err) {
      this.logger.error(
        `Disparo de alertas falhou para a captura ${capture.id}: ${(err as Error).message}`,
      );
    }
  }

  async dispatch(capture: CapturedMessage): Promise<number> {
    const rules = await this.candidateRules(capture);
    if (rules.length === 0) return 0;

    const userIds = [...new Set(rules.map((r) => r.userId))];
    const plans = await this.entitlements.plansFor(userIds);
    const freeUsers = userIds.filter((id) => plans.get(id) === Plan.FREE);

    const [freeActiveRule, freeMonitorIds] = await Promise.all([
      this.freeActiveRules(freeUsers),
      freeUsers.length ? this.feedAccess.freeMonitorIds() : Promise.resolve([]),
    ]);
    const captureIsFree =
      capture.monitorId !== null && freeMonitorIds.includes(capture.monitorId);

    const drafts = matchCapture(capture, rules, {
      plans,
      freeActiveRule,
      captureIsFree,
    });
    if (drafts.length === 0) return 0;

    // `skipDuplicates` + único (userId, capturedMessageId): reprocessar o mesmo
    // evento não duplica — e o que volta são SÓ as linhas inseridas agora, então
    // nem o socket nem o push repetem.
    const created = await this.prisma
      .getWriteClient()
      .notification.createManyAndReturn({
        data: drafts,
        skipDuplicates: true,
        select: {
          id: true,
          userId: true,
          title: true,
          body: true,
          capturedMessageId: true,
          createdAt: true,
        },
      });

    for (const { userId, ...notification } of created) {
      this.events.emit(NOTIFICATION_CREATED_EVENT, {
        userId,
        notification,
      } satisfies NotificationCreatedEvent);
    }

    await Promise.all(
      created.map((n) =>
        this.push.sendToUser(n.userId, {
          title: n.title,
          body: n.body,
          url: `/radar?message=${encodeURIComponent(n.capturedMessageId)}`,
          tag: n.id,
        }),
      ),
    );

    return created.length;
  }

  /** Regras ativas que PODEM casar — o `matchCapture` dá a palavra final. */
  private async candidateRules(
    capture: CapturedMessage,
  ): Promise<RuleForMatch[]> {
    const db = this.prisma.getReadClient();
    const select = {
      id: true,
      userId: true,
      kind: true,
      value: true,
      label: true,
    };
    const exact = [
      { kind: AlertKind.CHANNEL, value: capture.channelId },
      ...(capture.authorTag
        ? [{ kind: AlertKind.AUTHOR, value: capture.authorTag }]
        : []),
    ];

    const [byTarget, byKeyword] = await Promise.all([
      db.alertRule.findMany({
        where: { isActive: true, OR: exact },
        select,
      }),
      // Termo gravado em minúsculas; `strpos` = "contém", sem regex (o valor é
      // do usuário e não pode virar padrão). Parametrizado — sem concatenação.
      capture.text
        ? db.$queryRaw<RuleForMatch[]>`
            SELECT "id", "userId", "kind", "value", "label"
            FROM "AlertRule"
            WHERE "kind" = 'KEYWORD'::"AlertKind"
              AND "isActive" = true
              AND strpos(lower(${capture.text}), "value") > 0
          `
        : Promise.resolve([] as RuleForMatch[]),
    ]);
    return [...byTarget, ...byKeyword];
  }

  /** FREE: a regra que vale é a mais antiga ATIVA de cada usuário. */
  private async freeActiveRules(
    userIds: string[],
  ): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.prisma.getReadClient().alertRule.findMany({
      where: { userId: { in: userIds }, isActive: true },
      orderBy: [{ userId: 'asc' }, { createdAt: 'asc' }],
      distinct: ['userId'],
      select: { id: true, userId: true },
    });
    return new Map(rows.map((r) => [r.userId, r.id]));
  }

  /** Limpeza diária — o sininho mostra o recente, não guarda histórico eterno. */
  @Cron(CronExpression.EVERY_DAY_AT_5AM)
  async purgeOld(): Promise<void> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const { count } = await this.prisma
      .getWriteClient()
      .notification.deleteMany({ where: { createdAt: { lt: cutoff } } });
    if (count) this.logger.log(`Notificações antigas apagadas: ${count}`);
  }
}
