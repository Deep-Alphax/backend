import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { EntitlementsModule } from '../billing/entitlements.module';
import { FeedModule } from '../feed/feed.module';
import { AlertsController } from './alerts.controller';
import { AlertsService } from './alerts.service';
import { AlertDispatchService } from './alert-dispatch.service';
import { PushService } from './push.service';

/**
 * Alertas: regras do usuário, notificações (sininho + socket) e Web Push.
 *
 * Importa `FeedModule` pelo `FeedAccessService`: o FREE só é alertado de
 * captura que ele poderia ver no feed — a mesma regra, não uma cópia.
 */
@Module({
  imports: [PrismaModule, EntitlementsModule, FeedModule],
  controllers: [AlertsController],
  providers: [AlertsService, AlertDispatchService, PushService],
})
export class AlertsModule {}
