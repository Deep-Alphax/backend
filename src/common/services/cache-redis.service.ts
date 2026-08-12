import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from 'redis';

/**
 * Cache genérico key-value baseado em Redis com fallback fail-open:
 * quando Redis está desabilitado ou indisponível, todas as operações se
 * comportam como cache-miss (get retorna `null`, set/del viram no-op),
 * permitindo que a aplicação continue funcionando sem degradar.
 *
 * Não use este serviço para dados que precisam de garantia de presença
 * (locks, contadores, idempotência). Para esses, usar serviços específicos.
 */
@Injectable()
export class CacheRedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CacheRedisService.name);
  private client: ReturnType<typeof createClient> | null = null;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client?.isOpen) {
      await this.client.quit().catch(() => undefined);
    }
    this.client = null;
  }

  private async connect(): Promise<void> {
    // Redis SEMPRE ativo (sem flag REDIS_ENABLED). Host default = 127.0.0.1.
    // Fail-open: se a conexão falhar, o cache vira no-op e a app segue funcionando.
    try {
      const c = createClient({
        socket: {
          host: this.configService.get<string>('REDIS_HOST') ?? '127.0.0.1',
          port: this.configService.get<number>('REDIS_PORT', 6379),
        },
        password:
          this.configService.get<string>('REDIS_PASSWORD') || undefined,
        database: this.configService.get<number>('REDIS_CACHE_DB', 0),
      });
      c.on('error', (e: Error) =>
        this.logger.warn(`cache-redis: ${e.message}`),
      );
      await c.connect();
      this.client = c;
      this.logger.log('CacheRedis connected');
    } catch (e: any) {
      this.logger.warn(
        `CacheRedis unavailable, cache disabled: ${e.message}`,
      );
    }
  }

  isAvailable(): boolean {
    return !!this.client?.isOpen;
  }

  async getJson<T>(key: string): Promise<T | null> {
    if (!this.client?.isOpen) return null;
    try {
      const raw = await this.client.get(key);
      if (!raw) return null;
      const text = typeof raw === 'string' ? raw : raw.toString('utf8');
      return JSON.parse(text) as T;
    } catch (e: any) {
      this.logger.warn(`cache get failed (${key}): ${e?.message}`);
      return null;
    }
  }

  async setJson<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    if (!this.client?.isOpen) return;
    try {
      await this.client.set(key, JSON.stringify(value), { EX: ttlSeconds });
    } catch (e: any) {
      this.logger.warn(`cache set failed (${key}): ${e?.message}`);
    }
  }

  async del(key: string | string[]): Promise<void> {
    if (!this.client?.isOpen) return;
    try {
      if (Array.isArray(key)) {
        if (key.length === 0) return;
        await this.client.del(key);
      } else {
        await this.client.del(key);
      }
    } catch (e: any) {
      this.logger.warn(`cache del failed: ${e?.message}`);
    }
  }
}
