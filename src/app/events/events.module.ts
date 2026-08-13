import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { EventsGateway } from './events.gateway';

/**
 * Canal WebSocket de tempo real. `JwtModule.register({})` provê um `JwtService`
 * "cru" — a verificação passa o secret explicitamente (HS256), então não depende
 * da config do AuthModule (sem acoplamento). O `EventsGateway` escuta eventos
 * internos (EventEmitter global) e empurra para o dono via socket.
 */
@Module({
  imports: [JwtModule.register({})],
  providers: [EventsGateway],
})
export class EventsModule {}
