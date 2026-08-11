import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Request } from 'express';
import { isTrustedOrigin } from '../config/allowed-origins';

/**
 * Defesa CSRF STATELESS (substitui o token CSRF, removido em 2026-06-12).
 *
 * Bloqueia mutações (POST/PUT/PATCH/DELETE) cujo header `Origin` (ou a origem
 * derivada do `Referer`) seja de um site NÃO confiável. Por quê isto basta:
 *  - Um ataque CSRF parte de outro site no navegador da vítima; o navegador
 *    SEMPRE anexa o `Origin` real nessas requisições cross-site e o JS atacante
 *    NÃO consegue forjá-lo/suprimi-lo. Origem estrangeira ⇒ bloqueio.
 *  - Funciona mesmo com `SameSite=None` (dev) — não depende do cookie.
 *
 * SEM Origin nem Referer ⇒ LIBERA: requests server-to-server (webhook da Cielo),
 * apps nativos/mobile e ferramentas não são o modelo de ameaça de CSRF (CSRF
 * exige um navegador com o cookie da vítima). Assim não quebramos esses clientes.
 */
@Injectable()
export class RequestOriginGuard implements CanActivate {
  private static readonly MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    if (!RequestOriginGuard.MUTATING.has(request.method)) return true;

    const origin = this.resolveOrigin(request);

    // Sem origem declarada → não-navegador → fora do modelo de ameaça → libera.
    if (!origin) return true;

    // Origem presente porém não confiável → provável CSRF cross-site → bloqueia.
    if (!isTrustedOrigin(origin)) {
      throw new ForbiddenException('Origem da requisição não permitida');
    }

    return true;
  }

  /** Origem da request: header `Origin` direto, ou derivada do `Referer`. */
  private resolveOrigin(request: Request): string | undefined {
    const origin = request.headers.origin;
    if (origin) return origin;
    const referer = request.headers.referer;
    if (!referer) return undefined;
    try {
      const url = new URL(referer);
      return `${url.protocol}//${url.host}`;
    } catch {
      return undefined;
    }
  }
}
