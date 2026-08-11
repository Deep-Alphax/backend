import { SetMetadata } from '@nestjs/common';
import { CacheTTL as NestCacheTTL } from '@nestjs/cache-manager';

export const NO_CACHE = 'no-cache';
export const NoCache = () => SetMetadata(NO_CACHE, true);
/** TTL em ms; usa a mesma metadata do CacheInterceptor do @nestjs/cache-manager */
export const CacheTTL = NestCacheTTL;
