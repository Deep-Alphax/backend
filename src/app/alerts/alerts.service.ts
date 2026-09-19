import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Plan, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EntitlementsService } from '../billing/entitlements.service';
import { limitsFor, planLimitError } from '../billing/plan-limits';
import { normalizeRuleValue } from './alert-match';
import { isAllowedPushEndpoint } from './push-endpoint';
import {
  CreateAlertRuleDto,
  NotificationsQueryDto,
  PushSubscribeDto,
  UpdateAlertRuleDto,
} from './dto/alert.dto';

const RULE_SELECT = {
  id: true,
  kind: true,
  value: true,
  label: true,
  isActive: true,
  createdAt: true,
} satisfies Prisma.AlertRuleSelect;

const NOTIFICATION_SELECT = {
  id: true,
  title: true,
  body: true,
  readAt: true,
  createdAt: true,
  capturedMessageId: true,
  rule: { select: { id: true, kind: true } },
} satisfies Prisma.NotificationSelect;

const DEFAULT_PAGE = 20;

/** Regras, sininho e inscrições de push — tudo escopado por `userId`. */
@Injectable()
export class AlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
  ) {}

  // ── Regras ─────────────────────────────────────────────────────────────────

  /**
   * Regras + o que o plano permite. `effective` diz se a regra DISPARA hoje: no
   * FREE só a mais antiga ativa — a UI marca as outras como "Pro" em vez de
   * fingir que funcionam.
   */
  async listRules(userId: string) {
    const [rules, plan] = await Promise.all([
      this.prisma.getReadClient().alertRule.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        select: RULE_SELECT,
      }),
      this.entitlements.planFor(userId),
    ]);
    const { alertRules: limit } = limitsFor(plan);
    const firstActive = rules.find((r) => r.isActive)?.id;
    return {
      plan,
      limit,
      items: rules.map((r) => ({
        ...r,
        effective: r.isActive && (plan === Plan.PRO || r.id === firstActive),
      })),
    };
  }

  async createRule(userId: string, dto: CreateAlertRuleDto) {
    const value = normalizeRuleValue(dto.kind, dto.value);
    if (value.length < 2) throw new BadRequestException('value is too short');

    const write = this.prisma.getWriteClient();
    const [{ alertRules: limit }, count] = await Promise.all([
      this.entitlements.limitsFor(userId),
      write.alertRule.count({ where: { userId } }),
    ]);
    if (limit !== null && count >= limit) {
      throw planLimitError(
        'The Free plan includes 1 alert. Upgrade to Pro for unlimited alerts.',
        limit,
      );
    }

    try {
      return await write.alertRule.create({
        data: {
          userId,
          kind: dto.kind,
          value,
          label: dto.label?.trim() || null,
        },
        select: RULE_SELECT,
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException('You already have this alert.');
      }
      throw err;
    }
  }

  async updateRule(userId: string, id: string, dto: UpdateAlertRuleDto) {
    const write = this.prisma.getWriteClient();
    // `updateMany` com userId no where: regra de outra conta vira 0 linhas → 404,
    // sem revelar que o id existe.
    const { count } = await write.alertRule.updateMany({
      where: { id, userId },
      data: {
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        ...(dto.label !== undefined && { label: dto.label.trim() || null }),
      },
    });
    if (count === 0) throw new NotFoundException('Alert not found');
    return write.alertRule.findUnique({ where: { id }, select: RULE_SELECT });
  }

  async deleteRule(userId: string, id: string): Promise<{ ok: true }> {
    const { count } = await this.prisma
      .getWriteClient()
      .alertRule.deleteMany({ where: { id, userId } });
    if (count === 0) throw new NotFoundException('Alert not found');
    return { ok: true };
  }

  // ── Sininho ────────────────────────────────────────────────────────────────

  /** Mais recentes primeiro, por cursor (estável mesmo com notificação chegando). */
  async listNotifications(userId: string, q: NotificationsQueryDto) {
    const limit = q.limit ?? DEFAULT_PAGE;
    const rows = await this.prisma.getReadClient().notification.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(q.cursor && { cursor: { id: q.cursor }, skip: 1 }),
      select: NOTIFICATION_SELECT,
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return {
      items,
      nextCursor: hasMore ? items[items.length - 1].id : null,
    };
  }

  async unreadCount(userId: string): Promise<{ count: number }> {
    const count = await this.prisma
      .getReadClient()
      .notification.count({ where: { userId, readAt: null } });
    return { count };
  }

  async markRead(userId: string, id: string): Promise<{ ok: true }> {
    await this.prisma.getWriteClient().notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true };
  }

  async markAllRead(userId: string): Promise<{ ok: true }> {
    await this.prisma.getWriteClient().notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true };
  }

  // ── Web Push ───────────────────────────────────────────────────────────────

  /**
   * Upsert pelo `endpoint`: ele identifica o NAVEGADOR, não a conta. Se outra
   * conta logar no mesmo navegador e ativar o push, a inscrição passa para ela —
   * senão os alertas da conta anterior continuariam aparecendo ali.
   */
  async subscribePush(
    userId: string,
    dto: PushSubscribeDto,
    userAgent?: string,
  ): Promise<{ ok: true }> {
    if (!isAllowedPushEndpoint(dto.endpoint)) {
      throw new BadRequestException('Unsupported push endpoint.');
    }
    const data = {
      userId,
      p256dh: dto.keys.p256dh,
      auth: dto.keys.auth,
      userAgent: userAgent?.slice(0, 300) ?? null,
    };
    await this.prisma.getWriteClient().pushSubscription.upsert({
      where: { endpoint: dto.endpoint },
      create: { endpoint: dto.endpoint, ...data },
      update: data,
    });
    return { ok: true };
  }

  async unsubscribePush(
    userId: string,
    endpoint: string,
  ): Promise<{ ok: true }> {
    await this.prisma
      .getWriteClient()
      .pushSubscription.deleteMany({ where: { userId, endpoint } });
    return { ok: true };
  }
}
