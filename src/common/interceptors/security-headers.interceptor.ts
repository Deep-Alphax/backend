import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

@Injectable()
export class SecurityHeadersInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const response = context.switchToHttp().getResponse();
    
    // Verificar se a resposta já foi enviada (ex: redirect)
    const isResponseSent = response.headersSent || response.finished;
    
    if (!isResponseSent) {
      response.setHeader('X-Frame-Options', 'DENY');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      response.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
      response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      response.setHeader(
        'Content-Security-Policy',
        "frame-ancestors 'self' https://web.telegram.org",
      );
    }
    
    return next.handle().pipe(
      tap(() => {
        // Verificar novamente antes de setar Cache-Control
        if (!isResponseSent && !response.headersSent && !response.finished) {
          if (!response.getHeader('Cache-Control')) {
            response.setHeader(
              'Cache-Control',
              'no-store, no-cache, must-revalidate',
            );
          }
        }
      }),
    );
  }
}
