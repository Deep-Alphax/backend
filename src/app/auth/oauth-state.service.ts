import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { sanitizeRelativePath } from '../../common/utils/safe-redirect.util';

/**
 * Serializa/valida o parâmetro `state` do OAuth (round-trip pelo Google).
 *
 * O Google só devolve o `state` que mandamos — então é o canal correto para propagar o
 * destino pós-login (`redirect_to`) através do consent. Assinamos com HMAC (JWT/HS256,
 * `JWT_SECRET`) para que o backend possa CONFIAR no valor de volta (anti-tampering), com
 * expiração curta + nonce aleatório (limita replay e torna o state imprevisível — também
 * serve de proteção CSRF básica do fluxo OAuth).
 *
 * O `redirect_to` é saneado na ASSINATURA e de novo na VERIFICAÇÃO (defesa em profundidade
 * contra open-redirect — ver `sanitizeRelativePath`).
 */
@Injectable()
export class OAuthStateService {
  private readonly logger = new Logger(OAuthStateService.name);
  private readonly secret: string;
  // Janela curta: o usuário faz o consent na hora; 10 min cobre folga sem virar replay token.
  private static readonly TTL = '10m';

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {
    this.secret = this.config.get<string>('JWT_SECRET') ?? '';
  }

  /** Assina o state com o destino saneado. `redirect_to` inválido vira ausente (login no default). */
  sign(redirectTo?: string | null): string {
    const safe = sanitizeRelativePath(redirectTo);
    return this.jwt.sign(
      { rt: safe ?? undefined, n: crypto.randomBytes(16).toString('hex') },
      { secret: this.secret, expiresIn: OAuthStateService.TTL },
    );
  }

  /**
   * Valida o state e devolve o destino saneado (ou `null` se ausente/expirado/adulterado).
   * NUNCA lança — falha de state não pode quebrar o login; cai no destino default.
   */
  verify(state?: string | null): { redirectTo: string | null } {
    if (!state) return { redirectTo: null };
    try {
      const payload = this.jwt.verify<{ rt?: string }>(state, { secret: this.secret });
      return { redirectTo: sanitizeRelativePath(payload?.rt) };
    } catch (err) {
      this.logger.warn(`OAuth state inválido/expirado: ${(err as Error).message}`);
      return { redirectTo: null };
    }
  }
}
