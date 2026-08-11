import { Injectable, ExecutionContext } from '@nestjs/common';
import { AuthGuard, IAuthModuleOptions } from '@nestjs/passport';
import { OAuthStateService } from '../oauth-state.service';

@Injectable()
export class GoogleAuthGuard extends AuthGuard('google') {
  constructor(private readonly oauthState: OAuthStateService) {
    super();
  }

  // Sobrescrever para garantir que apenas a estratégia Google seja usada
  // e não tente usar a estratégia padrão (JWT)
  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      const result = (await super.canActivate(context)) as boolean;
      return result;
    } catch (error) {
      // Se falhar, relançar o erro
      throw error;
    }
  }

  /**
   * Injeta o parâmetro `state` na URL de consent do Google. Capturamos o `redirect_to`
   * da query de `GET /auth/google`, saneamos e assinamos — o Google devolve esse mesmo
   * `state` no callback do backend, de onde extraímos o destino pós-login.
   * É o único canal confiável (o Google só ecoa o `state`).
   */
  getAuthenticateOptions(context: ExecutionContext): IAuthModuleOptions {
    const req = context.switchToHttp().getRequest();
    const state = this.oauthState.sign(req?.query?.redirect_to);
    return { state };
  }

  handleRequest(err: any, user: any, info: any) {
    // Se houver erro ou não houver usuário, lançar exceção
    if (err) {
      throw err;
    }
    if (!user) {
      throw new Error('Falha na autenticação com o Google');
    }
    return user;
  }
}
