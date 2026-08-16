import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { FavoritesService } from './favorites.service';
import { CreateFavoriteDto, FavoritesFeedQueryDto } from './dto/favorite.dto';

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

  @Delete(':authorId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deixa de seguir um autor' })
  remove(@Request() req, @Param('authorId') authorId: string) {
    return this.favorites.remove(req.user.id, authorId);
  }
}
