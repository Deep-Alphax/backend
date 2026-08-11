import { Injectable, ExecutionContext } from '@nestjs/common';
import { CacheInterceptor } from '@nestjs/cache-manager';
import { NO_CACHE } from '../decorators/cache.decorator';
import { Reflector } from '@nestjs/core';
import { Cache } from 'cache-manager';

type RequestWithUser = {
  user?: { id?: string; sub?: string };
};

@Injectable()
export class HttpCacheInterceptor extends CacheInterceptor {
  constructor(cacheManager: Cache, reflector: Reflector) {
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
