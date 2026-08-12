import { CacheModule } from '@nestjs/cache-manager';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { redisStore } from 'cache-manager-redis-yet';
import { RedisClientOptions } from 'redis';
import { Logger } from '@nestjs/common';

const logger = new Logger('CacheConfig');

export function getCacheConfig() {
  // Cache SEMPRE via Redis (sem flag REDIS_ENABLED). Host default = 127.0.0.1.
  // Se o Redis estiver inacessível no boot, cai para cache em memória (fail-open):
  // a aplicação nunca deixa de subir por causa do cache.
  return CacheModule.registerAsync<RedisClientOptions>({
    imports: [ConfigModule],
    isGlobal: true,
    inject: [ConfigService],
    useFactory: async (configService: ConfigService) => {
      const host = configService.get<string>('REDIS_HOST') ?? '127.0.0.1';
      const port = configService.get<number>('REDIS_PORT', 6379);
      const password = configService.get<string>('REDIS_PASSWORD');
      const db = configService.get<number>('REDIS_DB', 0);

      try {
        const store = await redisStore({
          socket: {
            host,
            port,
            connectTimeout: 10000,
            reconnectStrategy: (retries) =>
              retries > 3 ? new Error('Redis connection failed') : retries * 100,
          },
          password: password || undefined,
          database: db,
        });

        if (!store?.client) throw new Error('Redis store criado sem client');
        if (typeof store.client.connect === 'function' && !store.client.isOpen) {
          await store.client.connect();
        }

        logger.log(`[CacheConfig] ✅ Redis ativo em ${host}:${port} (db=${db})`);
        return { store, ttl: 600 * 1000, max: 10000 };
      } catch (error: any) {
        // Fail-open: sem Redis, usa memória (store default do cache-manager).
        logger.error(
          `[CacheConfig] ❌ Redis indisponível (${host}:${port}): ${error?.message}. Fallback: cache em memória.`,
        );
        return { ttl: 600 * 1000, max: 10000 };
      }
    },
  });
}

