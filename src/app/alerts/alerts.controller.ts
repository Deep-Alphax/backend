import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AlertsService } from './alerts.service';
import { PushService } from './push.service';
import {
  CreateAlertRuleDto,
  NotificationsQueryDto,
  PushSubscribeDto,
  PushUnsubscribeDto,
  UpdateAlertRuleDto,
} from './dto/alert.dto';

/**
 * Alertas do usuário logado. Toda rota é escopada por `req.user.id`; o limite
 * de regras por plano (FREE 1, PRO ilimitado) é aplicado no service.
 */
@ApiTags('Alerts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/v1')
export class AlertsController {
  constructor(
    private readonly alerts: AlertsService,
    private readonly push: PushService,
  ) {}

  // ── Regras ──

  @Get('alerts/rules')
  @ApiOperation({ summary: 'Regras de alerta + limite do plano' })
  listRules(@Request() req) {
    return this.alerts.listRules(req.user.id);
  }

  @Post('alerts/rules')
  @Throttle({ short: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Cria uma regra (403 PLAN_LIMIT acima do plano)' })
  createRule(@Request() req, @Body() dto: CreateAlertRuleDto) {
    return this.alerts.createRule(req.user.id, dto);
  }

  @Patch('alerts/rules/:id')
  @ApiOperation({ summary: 'Liga/desliga ou renomeia uma regra' })
  updateRule(
    @Request() req,
    @Param('id') id: string,
    @Body() dto: UpdateAlertRuleDto,
  ) {
    return this.alerts.updateRule(req.user.id, id, dto);
  }

  @Delete('alerts/rules/:id')
  @ApiOperation({ summary: 'Apaga uma regra' })
  deleteRule(@Request() req, @Param('id') id: string) {
    return this.alerts.deleteRule(req.user.id, id);
  }

  // ── Sininho ──

  @Get('notifications')
  @ApiOperation({ summary: 'Notificações, mais recentes primeiro (cursor)' })
  list(@Request() req, @Query() q: NotificationsQueryDto) {
    return this.alerts.listNotifications(req.user.id, q);
  }

  @Get('notifications/unread-count')
  @ApiOperation({ summary: 'Quantas não lidas (badge do sininho)' })
  unread(@Request() req) {
    return this.alerts.unreadCount(req.user.id);
  }

  // Declarada ANTES de `:id/read` só por clareza: caminhos distintos.
  @Post('notifications/read-all')
  @HttpCode(200)
  @ApiOperation({ summary: 'Marca todas como lidas' })
  readAll(@Request() req) {
    return this.alerts.markAllRead(req.user.id);
  }

  @Post('notifications/:id/read')
  @HttpCode(200)
  @ApiOperation({ summary: 'Marca uma como lida' })
  read(@Request() req, @Param('id') id: string) {
    return this.alerts.markRead(req.user.id, id);
  }

  // ── Web Push ──

  @Get('notifications/push/key')
  @ApiOperation({ summary: 'Chave VAPID pública (null = push desligado)' })
  pushKey() {
    return { publicKey: this.push.vapidPublicKey };
  }

  @Post('notifications/push/subscriptions')
  @HttpCode(200)
  @Throttle({ short: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Registra este navegador para push' })
  subscribe(
    @Request() req,
    @Body() dto: PushSubscribeDto,
    @Headers('user-agent') ua?: string,
  ) {
    return this.alerts.subscribePush(req.user.id, dto, ua);
  }

  @Delete('notifications/push/subscriptions')
  @ApiOperation({ summary: 'Remove este navegador do push' })
  unsubscribe(@Request() req, @Body() dto: PushUnsubscribeDto) {
    return this.alerts.unsubscribePush(req.user.id, dto.endpoint);
  }
}
