import { CanActivate, ExecutionContext, Injectable, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class TurnstileGuard implements CanActivate {
  private readonly logger = new Logger(TurnstileGuard.name);

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const secretKey = this.config.get<string>('CLOUDFLARE_TURNSTILE_SECRET_KEY');

    if (!secretKey) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('CLOUDFLARE_TURNSTILE_SECRET_KEY is required in production');
      }
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const token: string | undefined = request.body?.turnstileToken;

    if (!token) {
      throw new BadRequestException('Verificação de segurança inválida.');
    }

    const remoteip: string =
      request.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || request.ip;

    try {
      const { data } = await firstValueFrom(
        this.http.post<{ success: boolean; 'error-codes'?: string[] }>(
          'https://challenges.cloudflare.com/turnstile/v0/siteverify',
          { secret: secretKey, response: token, remoteip },
          { headers: { 'Content-Type': 'application/json' } },
        ),
      );

      if (!data.success) {
        this.logger.warn(`Turnstile failed: ${JSON.stringify(data['error-codes'])} ip=${remoteip}`);
        throw new BadRequestException('Verificação de segurança inválida.');
      }

      return true;
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      // Network/API failure — fail closed in production
      this.logger.error(`Turnstile API error: ${err.message}`);
      if (process.env.NODE_ENV === 'production') {
        throw new BadRequestException('Verificação de segurança inválida.');
      }
      return true;
    }
  }
}
