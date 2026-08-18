import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Request,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { FavoritesService } from './favorites.service';
import {
  CreateFavoriteDto,
  FavoritesFeedQueryDto,
  UpdateFavoriteDto,
} from './dto/favorite.dto';

/** Teto do upload da foto do avatar (anti-DoS). */
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

/**
 * Autores favoritos do Radar, escopados por conta (`req.user.id`). Qualquer
 * usuário autenticado (JWT) gere apenas os próprios favoritos.
 */
@ApiTags('Feed · Favoritos')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/v1/feed/favorites')
export class FavoritesController {
  constructor(private readonly favorites: FavoritesService) {}

  @Get()
  @ApiOperation({ summary: 'Lista os autores seguidos pela conta' })
  list(@Request() req) {
    return this.favorites.list(req.user.id);
  }

  @Get('messages')
  @ApiOperation({ summary: 'Feed paginado das capturas dos autores seguidos' })
  messages(@Request() req, @Query() query: FavoritesFeedQueryDto) {
    return this.favorites.listMessages(req.user.id, query);
  }

  @Post()
  @ApiOperation({ summary: 'Segue um autor (idempotente)' })
  add(@Request() req, @Body() dto: CreateFavoriteDto) {
    return this.favorites.add(req.user.id, dto);
  }

  @Patch(':authorId')
  @ApiOperation({ summary: 'Personaliza um favorito (apelido + cor)' })
  update(
    @Request() req,
    @Param('authorId') authorId: string,
    @Body() dto: UpdateFavoriteDto,
  ) {
    return this.favorites.update(req.user.id, authorId, dto);
  }

  @Post(':authorId/photo')
  @ApiOperation({ summary: 'Envia a foto do avatar de um favorito (imagem)' })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_PHOTO_BYTES, files: 1 },
    }),
  )
  photo(
    @Request() req,
    @Param('authorId') authorId: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('Arquivo de imagem ausente');
    }
    // Validação de imagem (400) e escopo/existência (404) tratados no service.
    return this.favorites.setPhoto(req.user.id, authorId, file.buffer);
  }

  @Delete(':authorId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deixa de seguir um autor' })
  remove(@Request() req, @Param('authorId') authorId: string) {
    return this.favorites.remove(req.user.id, authorId);
  }
}

/**
 * Serve a foto (webp) de um favorito pela chave `id` (cuid, não enumerável).
 * Público — como o avatar de usuário: a foto não é secreta e precisa carregar
 * num `<img>` sem cabeçalho de auth.
 */
@ApiTags('Feed · Favoritos')
@Controller('api/v1/feed/favorites/photo')
export class FavoritePhotoController {
  constructor(private readonly favorites: FavoritesService) {}

  @Get(':id')
  @ApiOperation({ summary: 'Foto do avatar de um favorito (webp). Público.' })
  async serve(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const photo = await this.favorites.getPhoto(id);
    if (!photo) throw new NotFoundException('Foto não encontrada');
    res.setHeader('Content-Type', photo.mime);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Content-Length', String(photo.data.length));
    res.end(photo.data);
  }
}
