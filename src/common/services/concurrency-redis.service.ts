import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from 'redis';

/**
 * Contador distribuído de requisições concorrentes (várias réplicas da API).
 * Fallback: o middleware usa Map em memória quando Redis não está habilitado.
 */
@Injectable()
export class ConcurrencyRedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConcurrencyRedisService.name);
  private client: ReturnType<typeof createClient> | null = null;
  private initAttempted = false;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    await this.ensureClient();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client?.isOpen) {
      await this.client.quit().catch(() => undefined);
    }
    this.client = null;
  }

  isEnabled(): boolean {
    return (
      this.configService.get<string>('REDIS_ENABLED') === 'true' &&
      !!this.configService.get<string>('REDIS_HOST')
    );
  }

  private async ensureClient(): Promise<ReturnType<typeof createClient> | null> {
    if (!this.isEnabled()) {
      return null;
    }
    if (this.client?.isOpen) {
      return this.client;
    }
    if (this.initAttempted && !this.client) {
      return null;
    }
    this.initAttempted = true;
    const host = this.configService.get<string>('REDIS_HOST');
    const port = this.configService.get<number>('REDIS_PORT', 6379);
    const password = this.configService.get<string>('REDIS_PASSWORD');
    const db = this.configService.get<number>('REDIS_CONCURRENCY_DB', 0);
    try {
      const c = createClient({
        socket: { host: host!, port },
        password: password && password.length > 0 ? password : undefined,
        database: db,
      });
      c.on('error', (err) =>
        this.logger.warn(`Redis concurrency client: ${err.message}`),
      );
      await c.connect();
      this.client = c;
      this.logger.log('Redis-backed concurrency limiter active');
      return this.client;
    } catch (e: any) {
      this.logger.warn(
        `Redis concurrency unavailable, using in-process Map: ${e?.message}`,
      );
      this.client = null;
      return null;
    }
  }

  /**
   * `null` = Redis não usado ou indisponível (usar Map em memória).
   * `false` = limite global excedido no Redis (429).
   * `true` = slot adquirido; chamar releaseInRedis ao terminar.
   */
  async tryAcquireInRedis(
    key: string,
    max: number,
    ttlSeconds: number,
  ): Promise<boolean | null> {
    if (!this.isEnabled()) {
      return null;
    }
    const c = await this.ensureClient();
    if (!c?.isOpen) {
      return null;
    }
    const redisKey = `conc:req:${key}`;
    try {
      const n = Number(await c.incr(redisKey));
      if (n === 1) {
        await c.expire(redisKey, ttlSeconds);
      }
      if (n > max) {
        await c.decr(redisKey);
        return false;
      }
      return true;
    } catch (e: any) {
      this.logger.warn(`tryAcquireInRedis failed: ${e?.message}`);
      return null;
    }
  }

  async releaseInRedis(key: string): Promise<void> {
    const c = this.client;
    if (!c?.isOpen) {
      return;
    }
    const redisKey = `conc:req:${key}`;
    try {
      const n = Number(await c.decr(redisKey));
      if (n < 0) {
        await c.set(redisKey, '0', { EX: 1 });
      }
    } catch (e: any) {
      this.logger.warn(`releaseInRedis failed: ${e?.message}`);
    }
  }
}
