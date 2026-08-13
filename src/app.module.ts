import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { PrismaModule } from './prisma/prisma.module';
import { CommonModule } from './common/common.module';
import { AuthModule } from './app/auth/auth.module';
import { UsersModule } from './app/users/users.module';
import { WalletsModule } from './app/wallets/wallets.module';
import { AnalyticsModule } from './app/analytics/analytics.module';
import { SourcesModule } from './app/sources/sources.module';
import { EventsModule } from './app/events/events.module';
import { getCacheConfig } from './config/cache.config';
import { IpThrottlerGuard } from './common/guards/ip-throttler.guard';
import { RequestOriginGuard } from './common/guards/request-origin.guard';
import { ResponseCompressionInterceptor } from './common/interceptors/response-compression.interceptor';
import { ConcurrencyLimiterMiddleware } from './common/middleware/concurrency-limiter.middleware';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    EventEmitterModule.forRoot(),
    getCacheConfig(),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([
      { name: 'short', ttl: 1000, limit: 10 },
      { name: 'medium', ttl: 10000, limit: 50 },
      { name: 'long', ttl: 60000, limit: 200 },
    ]),
    PrismaModule,
    CommonModule,
    AuthModule,
    UsersModule,
    WalletsModule,
    AnalyticsModule,
    SourcesModule,
    EventsModule,
  ],
  providers: [
    ConcurrencyLimiterMiddleware,
    ResponseCompressionInterceptor,
    // Rate-limit global por IP (real, via trust proxy).
    { provide: APP_GUARD, useClass: IpThrottlerGuard },
    // CSRF stateless: bloqueia mutações com Origin estrangeiro (libera sem Origin
    // = server-to-server/webhook). Global p/ cobrir toda rota que muda estado.
    { provide: APP_GUARD, useClass: RequestOriginGuard },
    { provide: APP_INTERCEPTOR, useClass: ResponseCompressionInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(ConcurrencyLimiterMiddleware).forRoutes('*');
  }
}
