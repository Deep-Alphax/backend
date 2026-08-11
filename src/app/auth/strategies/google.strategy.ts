import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, VerifyCallback } from 'passport-google-oauth20';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../auth.service';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(
    private configService: ConfigService,
    private authService: AuthService,
  ) {
    // Callback URL aponta para o BACKEND (GET /api/v1/auth/google/callback). O backend
    // recebe o `code` + `state`, extrai o `redirect_to` saneado do state e redireciona
    // para o frontend ({FRONTEND}/auth/callback?code=...&redirect_to=...). O front então
    // troca o code por tokens via POST /api/v1/auth/google/validate (redirectUri = este
    // mesmo callback do backend — o redirect_uri da troca precisa bater com o do consent).
    // Este `callbackURL` vira o `redirect_uri` da URL de consent → DEVE estar autorizado
    // no Google Cloud Console.
    const callbackUrl = configService.get<string>('GOOGLE_CALLBACK_URL');
    const port = configService.get<string>('PORT') || '3333';

    // Se GOOGLE_CALLBACK_URL estiver setado, usa como está; senão, default local p/ o backend.
    const finalCallbackUrl =
      callbackUrl || `http://localhost:${port}/api/v1/auth/google/callback`;

    // Fail-open em dev: sem credenciais Google, o passport-google-oauth20 lançaria
    // "OAuth2Strategy requires a clientID option" e DERRUBARIA o boot. Usamos
    // placeholders para a app subir; as rotas /auth/google só funcionam de fato
    // quando GOOGLE_CLIENT_ID/SECRET estiverem configurados (mesma filosofia do Turnstile).
    const clientID = configService.get<string>('GOOGLE_CLIENT_ID') || 'google-oauth-not-configured';
    const clientSecret =
      configService.get<string>('GOOGLE_CLIENT_SECRET') || 'google-oauth-not-configured';

    super({
      clientID,
      clientSecret,
      callbackURL: finalCallbackUrl,
      scope: ['email', 'profile'],
    });

    if (!configService.get<string>('GOOGLE_CLIENT_ID')) {
      new Logger(GoogleStrategy.name).warn(
        'GOOGLE_CLIENT_ID não configurado — login com Google desabilitado (app sobe normalmente).',
      );
    }
  }

  async validate(
    accessToken: string,
    refreshToken: string,
    profile: any,
    done: VerifyCallback,
  ): Promise<any> {
    const { id, name, emails, photos } = profile;

    // E-mail NÃO verificado pelo Google é rejeitado: validateGoogleUser vincula
    // a identidade Google a uma conta local existente só pelo e-mail — aceitar
    // e-mail não verificado permitia account takeover (atacante cria conta
    // Google com o e-mail da vítima sem confirmar a posse dele).
    if (emails?.[0]?.verified === false || emails?.[0]?.verified === 'false') {
      done(new UnauthorizedException('E-mail da conta Google não verificado'), false);
      return;
    }

    const user = {
      googleId: id,
      email: emails[0].value,
      firstName: name.givenName || '',
      lastName: name.familyName || '',
      avatarUrl: photos?.[0]?.value || null,
      accessToken,
    };

    done(null, user);
  }
}

