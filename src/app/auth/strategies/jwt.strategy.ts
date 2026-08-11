import { ExtractJwt, Strategy } from 'passport-jwt';
import type { Request } from 'express';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { resolveAuthSurface, accessCookieName } from '../auth-cookies.util';

/**
 * Extrai o JWT do cookie httpOnly da SUPERFÍCIE da request (resolvida pelo header
 * `x-pt-surface`) — cada superfície tem seu cookie (`pt_at_<surface>`), permitindo
 * sessões isoladas no mesmo navegador. cookie-parser popula `req.cookies`.
 */
function cookieTokenExtractor(req: Request): string | null {
  const surface = resolveAuthSurface(req);
  const token = (req?.cookies as Record<string, string> | undefined)?.[
    accessCookieName(surface)
  ];
  return token && token !== 'undefined' && token !== 'null' ? token : null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    super({
      // Bearer explícito PRIMEIRO; cookie httpOnly como fallback. Intenção explícita
      // (header Authorization enviado por API/Swagger/SSR) vence a credencial ambiente
      // (cookie). Sem isso, um cookie de sessão VELHO/inválido no cliente era extraído
      // antes e falhava a verificação, mascarando um Bearer VÁLIDO → 401 indevido.
      // O frontend não envia Authorization (usa só o cookie httpOnly) → cai no fallback,
      // sem mudança de comportamento pra ele.
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        cookieTokenExtractor,
      ]),
      ignoreExpiration: false,
      secretOrKey: configService.get('JWT_SECRET'),
      // Fixa o algoritmo: fecha a janela de confusão de algoritmo. HMAC simétrico.
      algorithms: ['HS256'],
      passReqToCallback: false,
    });
  }

  async validate(payload: any) {
    // Token de challenge MFA (mfaPending) NÃO dá acesso a rotas protegidas — é
    // consumido só pelo endpoint POST /auth/2fa/verify-login (valida no body).
    if (payload.mfaPending) {
      throw new UnauthorizedException('MFA não concluído');
    }

    const user = await this.prisma.getReadClient().user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        avatarUrl: true,
        role: true,
        isActive: true,
        language: true,
        mfaEnabled: true,
        emailVerified: true,
        passwordChangedAt: true,
        deletedAt: true,
      },
    });

    if (!user || !user.isActive || user.deletedAt) {
      throw new UnauthorizedException('Usuário não encontrado ou inativo');
    }

    // Revogação sem denylist: token emitido ANTES da última troca de senha é
    // inválido (troca/reset derruba sessões roubadas). Margem de 2s p/ clock skew.
    if (
      user.passwordChangedAt &&
      typeof payload.iat === 'number' &&
      payload.iat * 1000 < user.passwordChangedAt.getTime() - 2000
    ) {
      throw new UnauthorizedException('Sessão expirada — faça login novamente');
    }

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      avatarUrl: user.avatarUrl,
      role: user.role,
      language: user.language,
      mfaEnabled: user.mfaEnabled,
      emailVerified: user.emailVerified,
    };
  }
}
