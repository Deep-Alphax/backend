import { Injectable, ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  // Não tentar autenticar se não houver token (evita conflito com outras estratégias)
  canActivate(context: ExecutionContext) {
    return super.canActivate(context);
  }
} 