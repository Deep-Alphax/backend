import {
  Injectable,
  NestMiddleware,
  Logger,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { getClientIp } from '../utils/client-ip.util';

interface RateLimitEntry {
  count: number;
  resetTime: number;
  lastRequest: number;
}

@Injectable()
export class RateLimitMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RateLimitMiddleware.name);
  private readonly rateLimits = new Map<string, RateLimitEntry>();

  private readonly limits = {
    auth: { windowMs: 15 * 60 * 1000, maxRequests: 10 },
    api: { windowMs: 15 * 60 * 1000, maxRequests: 100 },
    upload: { windowMs: 60 * 60 * 1000, maxRequests: 50 },
    admin: { windowMs: 60 * 60 * 1000, maxRequests: 200 },
    deposits: { windowMs: 60 * 60 * 1000, maxRequests: 10 },
  };

  use(req: Request, res: Response, next: NextFunction) {
    const clientIP = this.getClientIP(req);
    const userAgent = req.headers['user-agent'] || 'unknown';
    const identifier = `${clientIP}:${userAgent}`;

    // Determinar tipo de endpoint
    const endpointType = this.getEndpointType(req.path);
    const limit = this.limits[endpointType];

    // Verificar rate limit
    if (!this.checkRateLimit(identifier, limit)) {
      this.logger.warn(`Rate limit exceeded for ${identifier} on ${endpointType} endpoint`);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Too many requests. Please try again later.',
          error: 'RATE_LIMIT_EXCEEDED',
          retryAfter: Math.ceil((this.rateLimits.get(identifier)?.resetTime || Date.now()) / 1000),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Adicionar headers de rate limit
    const entry = this.rateLimits.get(identifier);
    if (entry) {
      res.setHeader('X-RateLimit-Limit', limit.maxRequests);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, limit.maxRequests - entry.count));
      res.setHeader('X-RateLimit-Reset', Math.ceil(entry.resetTime / 1000));
    }

    next();
  }

  private getClientIP(req: Request): string {
    return getClientIp(req) || 'unknown';
  }

  private getEndpointType(path: string): keyof typeof RateLimitMiddleware.prototype.limits {
    if (path.startsWith('/api/v1/auth')) return 'auth';
    if (path.startsWith('/api/v1/upload')) return 'upload';
    if (path.startsWith('/api/v1/balance/deposit')) return 'deposits';
    if (path.includes('/admin') || path.startsWith('/api/v1/user') || path.startsWith('/api/v1/lootbox')) return 'admin';
    return 'api';
  }

  private checkRateLimit(identifier: string, limit: { windowMs: number; maxRequests: number }): boolean {
    const now = Date.now();
    const entry = this.rateLimits.get(identifier);

    if (!entry || now > entry.resetTime) {
      // Criar nova entrada ou resetar existente
      this.rateLimits.set(identifier, {
        count: 1,
        resetTime: now + limit.windowMs,
        lastRequest: now,
      });
      return true;
    }

    if (entry.count >= limit.maxRequests) {
      return false;
    }

    entry.count++;
    entry.lastRequest = now;
    return true;
  }

  // Método para limpar entradas antigas (pode ser chamado periodicamente)
  cleanup(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.rateLimits.entries()) {
      if (now > entry.resetTime) {
        this.rateLimits.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.debug(`Cleaned up ${cleaned} expired rate limit entries`);
    }
  }

  // Método para obter estatísticas (útil para monitoring)
  getStats(): { totalEntries: number; entries: Array<{ identifier: string; count: number; resetTime: number }> } {
    return {
      totalEntries: this.rateLimits.size,
      entries: Array.from(this.rateLimits.entries()).map(([identifier, entry]) => ({
        identifier,
        count: entry.count,
        resetTime: entry.resetTime,
      })),
    };
  }
}
