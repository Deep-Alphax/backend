import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);
  private readonly readReplica: PrismaClient | null = null;

  /**
   * Anexa connection_limit / pool_timeout à URL do Postgres se definidos em env
   * e ainda não estiverem na query string (Prisma/pg pool).
   */
  private static applyDatabaseUrlPoolParams(
    urlString: string | undefined,
  ): string | undefined {
    if (!urlString) return urlString;
    const limit = process.env.DATABASE_CONNECTION_LIMIT?.trim();
    const poolTimeout = process.env.DATABASE_POOL_TIMEOUT?.trim();
    if (!limit && !poolTimeout) return urlString;
    try {
      const u = new URL(urlString);
      if (limit && !u.searchParams.has('connection_limit')) {
        u.searchParams.set('connection_limit', limit);
      }
      if (poolTimeout && !u.searchParams.has('pool_timeout')) {
        u.searchParams.set('pool_timeout', poolTimeout);
      }
      return u.toString();
    } catch {
      return urlString;
    }
  }

  constructor(private configService: ConfigService) {
    const databaseUrl = PrismaService.applyDatabaseUrlPoolParams(
      configService.get<string>('DATABASE_URL'),
    );
    super({
      log:
        process.env.NODE_ENV === 'development'
          ? ['query', 'error', 'warn']
          : ['error'],
      datasources: {
        db: {
          url: databaseUrl,
        },
      },
    });

    const readReplicaUrl = PrismaService.applyDatabaseUrlPoolParams(
      configService.get<string>('DATABASE_READ_REPLICA_URL'),
    );
    if (readReplicaUrl) {
      this.readReplica = new PrismaClient({
        log: ['error'],
        datasources: {
          db: {
            url: readReplicaUrl,
          },
        },
      });
      this.logger.log('Read replica configured');
    }
  }

  async onModuleInit() {
    await this.$connect();
    if (this.readReplica) {
      await this.readReplica.$connect();
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
    if (this.readReplica) {
      await this.readReplica.$disconnect();
    }
  }

  /**
   * Retorna cliente Prisma para operações de leitura
   * Usa read replica se disponível, senão usa a conexão principal
   */
  getReadClient(): PrismaClient {
    return this.readReplica || this;
  }

  /**
   * Retorna cliente Prisma para operações de escrita
   * Sempre usa a conexão principal (master)
   */
  getWriteClient(): PrismaClient {
    return this;
  }

  /**
   * Sincroniza o read replica com o master (apenas em desenvolvimento)
   * Em produção, o read replica é sincronizado automaticamente via streaming replication
   */
  async syncReadReplica(): Promise<void> {
    if (process.env.NODE_ENV === 'production' || !this.readReplica) {
      return; // Em produção, a replicação é automática
    }

    // Em desenvolvimento, não sincronizamos automaticamente após cada escrita
    // pois seria muito custoso. O read replica deve ser sincronizado manualmente
    // usando `pnpm db:sync` ou via streaming replication quando configurado corretamente
    this.logger.debug(
      'Read replica sync skipped in development (manual sync required)',
    );
  }
}
