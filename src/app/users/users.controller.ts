import { Controller, Get, Param, Res, NotFoundException } from '@nestjs/common';
import { Response } from 'express';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { UsersService } from './users.service';

/**
 * Endpoints de usuário. Por ora só serve o avatar re-hospedado (público — a foto
 * de perfil não é secreta; é o que apareceria num `<img>`). Escopado por id (cuid,
 * não enumerável na prática).
 */
@ApiTags('Users')
@Controller('api/v1/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get(':id/avatar')
  @ApiOperation({ summary: 'Avatar re-hospedado do usuário (imagem webp). Público.' })
  @ApiResponse({ status: 200, description: 'Imagem do avatar' })
  @ApiResponse({ status: 404, description: 'Usuário sem avatar armazenado' })
  async avatar(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const avatar = await this.users.getAvatar(id);
    if (!avatar) throw new NotFoundException('Avatar não encontrado');

    res.setHeader('Content-Type', avatar.mime);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Content-Length', String(avatar.data.length));
    res.end(avatar.data);
  }
}
