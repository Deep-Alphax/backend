import {
  Controller,
  Get,
  Param,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { FeedService } from './feed.service';
import { FeedQueryDto } from './dto/monitor.dto';

/**
 * Leitura do feed de capturas do Discord. Qualquer usuário autenticado (JWT),
 * mas no recorte do plano dele: FREE só vê os grupos liberados pelo admin.
 */
@ApiTags('Feed')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/v1')
export class FeedController {
  constructor(private readonly feed: FeedService) {}

  @Get('feed/messages')
  @ApiOperation({
    summary: 'Lista as capturas do feed (paginado, filtros opcionais)',
  })
  list(@Request() req, @Query() query: FeedQueryDto) {
    return this.feed.list(req.user.id, query);
  }

  @Get('feed/messages/:id')
  @ApiOperation({ summary: 'Detalhe de uma captura' })
  getOne(@Request() req, @Param('id') id: string) {
    return this.feed.getById(req.user.id, id);
  }

  @Get('feed/groups')
  @ApiOperation({
    summary: 'Árvore de grupos (servidores) e subgrupos (canais) com contagens reais',
  })
  groups(@Request() req) {
    return this.feed.getGroups(req.user.id);
  }

  @Get('feed/author-stats')
  @ApiOperation({ summary: 'Estatísticas do perfil de um autor (mensagens, tokens, 1ª captura)' })
  authorStats(@Request() req, @Query('authorTag') authorTag: string) {
    return this.feed.getAuthorStats(req.user.id, authorTag);
  }
}
