import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

@Injectable()
export class BypassKeyGuard implements CanActivate {
  constructor(private configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const bypassKey = request.headers['x-api-bypass'] as string;
    const apiBypassKey = this.configService.get<string>('API_BYPASS_SECRET');
    if (bypassKey !== apiBypassKey) {
      throw new UnauthorizedException('Invalid or missing bypass key');
    }
    return true;
  }
}
