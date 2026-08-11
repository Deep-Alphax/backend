import { CacheModule } from '@nestjs/cache-manager';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { redisStore } from 'cache-manager-redis-yet';
import { RedisClientOptions } from 'redis';
import { Logger } from '@nestjs/common';

const logger = new Logger('CacheConfig');

export function getCacheConfig() {
  const redisHost = process.env.REDIS_HOST;
  const redisPort = process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379;
  const redisPassword = process.env.REDIS_PASSWORD;
  const redisEnabled = process.env.REDIS_ENABLED === 'true';

  logger.log(`[CacheConfig] Redis config check: enabled=${redisEnabled}, host=${redisHost}, port=${redisPort}, password=${redisPassword ? '***' : 'none'}`);

  // Se Redis estiver configurado E habilitado, usar Redis (mesmo em desenvolvimento)
  if (redisEnabled && redisHost) {
    logger.log('[CacheConfig] ✅ Redis enabled, attempting to register Redis store...');
    return CacheModule.registerAsync<RedisClientOptions>({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => {
        const host = configService.get<string>('REDIS_HOST');
        const port = configService.get<number>('REDIS_PORT', 6379);
        const password = configService.get<string>('REDIS_PASSWORD');
        const db = configService.get<number>('REDIS_DB', 0);

        logger.log(`[CacheConfig] useFactory called with host=${host}, port=${port}, db=${db}`);
        logger.log(`[CacheConfig] Attempting to connect to Redis at ${host}:${port}`);

        try {
          logger.log(`[CacheConfig] Creating Redis store with host=${host}, port=${port}, db=${db}`);
          
          const store = await redisStore({
            socket: {
              host,
              port,
              connectTimeout: 10000,
              reconnectStrategy: (retries) => {
                logger.log(`[CacheConfig] Redis reconnection attempt ${retries}`);
                if (retries > 3) {
                  logger.error('[CacheConfig] Redis connection failed after 3 retries');
                  return new Error('Redis connection failed');
                }
                return retries * 100;
              },
            },
            password: password || undefined,
            database: db,
          });

          logger.log(`[CacheConfig] Redis store created, checking client...`);
          
          // Verificar se o store tem cliente
          if (!store || !store.client) {
            throw new Error('Redis store created but client is missing');
          }

          logger.log(`[CacheConfig] Redis client found, type: ${typeof store.client}`);
          
          // Testar conexão explicitamente
          if (store.client && typeof store.client.connect === 'function') {
            try {
              // Verificar se já está conectado
              if (store.client.isOpen) {
                logger.log('[CacheConfig] ✅ Redis client already connected!');
              } else {
                await store.client.connect();
                logger.log('[CacheConfig] ✅ Redis client connected successfully!');
              }
            } catch (connectError: any) {
              // Se já estiver conectado, ignorar erro
              if (connectError.message && !connectError.message.includes('already connected') && !connectError.message.includes('Socket already opened')) {
                logger.warn('[CacheConfig] Redis client connection warning:', connectError.message);
              } else {
                logger.log('[CacheConfig] Redis client already connected (ignoring error)');
              }
            }
          }
          
          logger.log('[CacheConfig] ✅ Redis store initialized successfully!');
          
          // Testar se o store realmente funciona fazendo um set/get
          try {
            await store.set('cache:test:init', 'redis-works', 1000);
            const testValue = await store.get('cache:test:init');
            if (testValue === 'redis-works') {
              logger.log('[CacheConfig] ✅ Redis store test: SET/GET working correctly!');
            } else {
              logger.warn(`[CacheConfig] ⚠️ Redis store test: GET returned unexpected value: ${testValue}`);
            }
          } catch (testError: any) {
            logger.error('[CacheConfig] ❌ Redis store test failed:', testError.message);
          }
          
          return {
            store,
            ttl: 600 * 1000,
            max: 10000,
          };
        } catch (error: any) {
          logger.error('[CacheConfig] ❌ Failed to connect to Redis:', error.message);
          logger.error('[CacheConfig] Full error:', error);
          logger.error('[CacheConfig] Error stack:', error.stack);
          throw error;
        }
      },
      inject: [ConfigService],
      isGlobal: true,
    });
  }

  // Fallback para cache em memória
  logger.warn('⚠️  Redis not enabled or not configured, using in-memory cache');
  const isProduction = process.env.NODE_ENV === 'production';
  return CacheModule.register({
    isGlobal: true,
    ttl: 600000,
    max: isProduction ? 10000 : 1000,
  });
}

