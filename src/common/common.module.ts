import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { RequestOriginGuard } from './guards/request-origin.guard';
import { BypassKeyGuard } from './guards/bypass-key.guard';
import { ConcurrencyRedisService } from './services/concurrency-redis.service';
import { CacheRedisService } from './services/cache-redis.service';

/**
 * Infra transversal enxuta: guards de segurança (CSRF por origem + bypass key)
 * e os serviços Redis (cache e limite de concorrência). Telemetria/PDF/ticketing
 * foram removidos no pivot para o produto de analytics de carteiras.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    RequestOriginGuard,
    BypassKeyGuard,
    ConcurrencyRedisService,
    CacheRedisService,
  ],
  exports: [
    RequestOriginGuard,
    BypassKeyGuard,
    ConcurrencyRedisService,
    CacheRedisService,
  ],
})
export class CommonModule {}
