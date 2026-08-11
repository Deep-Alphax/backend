import {
  Injectable,
  NestMiddleware,
  Logger,
  Optional,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';
import { ConcurrencyRedisService } from '../services/concurrency-redis.service';
import { getClientIp } from '../utils/client-ip.util';

@Injectable()
export class ConcurrencyLimiterMiddleware implements NestMiddleware {
  private readonly logger = new Logger(ConcurrencyLimiterMiddleware.name);
  private readonly activeRequests = new Map<string, number>();
  // Teto de requisições não-GET SIMULTÂNEAS por identificador (usuário/IP).
  // Default 50 em TODOS os ambientes (não distingue mais dev/homolog/prod — o antigo
  // `production ? 50 : 1` tratava homolog como dev → teto 1 → 429 em quase todo POST).
  // Configurável via `MAX_CONCURRENT_REQUESTS` (ops ajusta sem deploy, se um dia precisar).
  private readonly maxConcurrentRequests = (() => {
    const fromEnv = parseInt(process.env.MAX_CONCURRENT_REQUESTS ?? '', 10);
    return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 50;
  })();
  private readonly requestTimeout = 30000;
  private readonly redisKeyTtlSeconds = 120;
  // Verificador de JWT para BUCKETAR o limite por USUÁRIO autenticado (não por IP).
  // Verifica assinatura + expiração com o mesmo JWT_SECRET — assim um token forjado NÃO
  // consegue criar buckets novos para furar o limite (cairia no IP). Null se não houver segredo.
  private readonly jwt: JwtService | null;

  constructor(
    @Optional()
    private readonly concurrencyRedis?: ConcurrencyRedisService,
  ) {
    // Lê JWT_SECRET no construtor em vez de field initializer para evitar que o valor
    // seja capturado antes da inicialização completa do processo (ex.: variáveis de
    // ambiente carregadas por dotenv após importação do módulo).
    const secret = process.env.JWT_SECRET;
    this.jwt = secret ? new JwtService({ secret }) : null;

    if (!concurrencyRedis) {
      this.logger.warn(
        'Redis not available — concurrency limiting is in-memory only. ' +
        'Multiple server instances will NOT share rate limit state. ' +
        'Set REDIS_URL to enable distributed rate limiting.',
      );
    }
  }

  async use(req: Request, res: Response, next: NextFunction) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

    const userId = this.getUserIdentifier(req);
    if (!userId) return next();

    if (this.concurrencyRedis) {
      const slot = await this.concurrencyRedis.tryAcquireInRedis(
        userId,
        this.maxConcurrentRequests,
        this.redisKeyTtlSeconds,
      );
      if (slot === false) {
        return res.status(429).json({
          statusCode: 429,
          message: 'Too many concurrent requests. Please try again later.',
        });
      }
      if (slot === true) {
        let released = false;
        let timeoutId: NodeJS.Timeout;
        const release = () => {
          if (released) return;
          released = true;
          clearTimeout(timeoutId);
          void this.concurrencyRedis!.releaseInRedis(userId);
        };
        timeoutId = setTimeout(release, this.requestTimeout);
        res.once('finish', release);
        res.once('close', release);
        return next();
      }
    }

    const currentCount = this.activeRequests.get(userId) || 0;

    if (currentCount >= this.maxConcurrentRequests) {
      return res.status(429).json({
        statusCode: 429,
        message: 'Too many concurrent requests. Please try again later.',
      });
    }
    this.activeRequests.set(userId, currentCount + 1);
    const timeoutId = setTimeout(() => {
      const count = this.activeRequests.get(userId) || 0;
      if (count > 0) {
        this.activeRequests.set(userId, count - 1);
        if (count - 1 <= 0) {
          this.activeRequests.delete(userId);
        }
      }
    }, this.requestTimeout);

    const cleanup = () => {
      clearTimeout(timeoutId);
      const newCount = (this.activeRequests.get(userId) || 1) - 1;
      if (newCount <= 0) {
        this.activeRequests.delete(userId);
      } else {
        this.activeRequests.set(userId, newCount);
      }
    };

    res.on('finish', cleanup);
    res.on('close', cleanup);

    next();
  }

  private getUserIdentifier(req: Request): string | null {
    // 1) Telegram (mini-app): identidade forte vinda do init data.
    if (req['telegramUserId']) return `telegram:${req['telegramUserId']}`;
    const telegramInitData = req.headers['x-telegram-init-data'] as string;
    if (telegramInitData) {
      try {
        const userId = this.extractUserIdFromInitData(telegramInitData);
        if (userId) return `telegram:${userId}`;
      } catch (error) {
        this.logger.error(
          'Error extracting user ID from Telegram init data:',
          error,
        );
      }
    }

    // 2) Usuário autenticado (JWT VERIFICADO) → bucket POR PESSOA. Evita que usuários
    //    distintos atrás do mesmo proxy/NAT compartilhem o limite (e o checkout, todo
    //    autenticado, deixa de colidir no IP do load balancer).
    const jwtUserId = this.extractJwtUserId(req);
    if (jwtUserId) return `user:${jwtUserId}`;

    // 3) Anônimo → IP REAL do cliente. getClientIp prioriza x-forwarded-for (proxy/LB à
    //    frente do Node); cai pra req.ip só quando não há XFF. Antes usava req.ip primeiro,
    //    que atrás de proxy é o IP do LB → TODOS caíam no mesmo bucket (teto global de 5).
    const clientIp = getClientIp(req);
    if (clientIp) {
      const ipHash = crypto.createHash('sha256').update(clientIp).digest('hex');
      return `ip:${ipHash}`;
    }
    return null;
  }

  /**
   * Extrai o `sub` (userId) de um Bearer JWT VÁLIDO. Verifica assinatura e expiração —
   * token ausente/forjado/expirado retorna null (cai pro IP). Não lança.
   */
  private extractJwtUserId(req: Request): string | null {
    if (!this.jwt) return null;
    const auth = req.headers['authorization'];
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return null;
    const token = auth.slice(7).trim();
    if (!token) return null;
    try {
      const payload = this.jwt.verify<{ sub?: string }>(token);
      return payload?.sub ? String(payload.sub) : null;
    } catch {
      return null;
    }
  }

  private extractUserIdFromInitData(initData: string): number | null {
    try {
      const idRegex = /"id":(\d+)/;
      const idMatch = initData.match(idRegex);
      if (idMatch && idMatch[1]) return parseInt(idMatch[1]);
      const decodedData = decodeURIComponent(initData);
      const urlParams = new URLSearchParams(decodedData);
      const userStr = urlParams.get('user');
      if (!userStr) return null;
      const userIdMatch = userStr.match(idRegex);
      if (userIdMatch) return parseInt(userIdMatch[1]);
      return null;
    } catch (error) {
      this.logger.error(
        'Error extracting user ID from Telegram init data:',
        error,
      );
      return null;
    }
  }
}
