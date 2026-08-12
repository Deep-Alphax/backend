import { Injectable, ExecutionContext, Inject } from '@nestjs/common';
import { CacheInterceptor, CACHE_MANAGER } from '@nestjs/cache-manager';
import { NO_CACHE } from '../decorators/cache.decorator';
import { Reflector } from '@nestjs/core';
import { Cache } from 'cache-manager';

type RequestWithUser = {
  user?: { id?: string; sub?: string };
};

@Injectable()
export class HttpCacheInterceptor extends CacheInterceptor {
  // @Inject explícito: ao sobrescrever o construtor da base, os metadados de DI
  // do CACHE_MANAGER se perdem — sem isto o Nest não resolve o cacheManager.
  constructor(
    @Inject(CACHE_MANAGER) cacheManager: Cache,
    reflector: Reflector,
  ) {
    super(cacheManager, reflector);
  }

  protected trackBy(context: ExecutionContext): string | undefined {
    const noCache = this.reflector.get(NO_CACHE, context.getHandler());
    if (noCache) return undefined;

    const base = super.trackBy(context);
    if (base === undefined) return undefined;

    const req = context.switchToHttp().getRequest<RequestWithUser>();
    const uid = req.user?.id ?? req.user?.sub;
    if (uid) {
      return `${base}::auth:${uid}`;
    }
    return base;
  }
}
