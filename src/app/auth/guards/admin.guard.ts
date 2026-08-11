import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (!user) throw new UnauthorizedException('Usuário não autenticado');
    const fullUser = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { id: true, isActive: true, role: true },
    });

    if (!fullUser) throw new UnauthorizedException('Usuário não encontrado');
    if (!fullUser.isActive) {
      throw new ForbiddenException('Conta do usuário está desativada');
    }
    if (fullUser.role !== 'ADMIN') {
      throw new ForbiddenException('Admin access required');
    }
    request.adminUser = fullUser;
    return true;
  }
}
