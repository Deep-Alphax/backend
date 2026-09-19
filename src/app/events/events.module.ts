import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { EventsGateway } from './events.gateway';
import { EntitlementsModule } from '../billing/entitlements.module';
import { FeedModule } from '../feed/feed.module';

/**
 * Canal WebSocket de tempo real. `JwtModule.register({})` provê um `JwtService`
 * "cru" — a verificação passa o secret explicitamente (HS256), então não depende
 * da config do AuthModule (sem acoplamento). O `EventsGateway` escuta eventos
 * internos (EventEmitter global) e empurra para o dono via socket.
 */
@Module({
  // Entitlements + FeedModule: a sala do feed depende do plano e do recorte de
  // grupos liberados — a mesma regra do REST, não uma cópia.
  imports: [JwtModule.register({}), EntitlementsModule, FeedModule],
  providers: [EventsGateway],
})
export class EventsModule {}
