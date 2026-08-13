import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { FeedService } from './feed.service';
import { FeedQueryDto } from './dto/monitor.dto';

/** Leitura do feed de capturas do Discord. Qualquer usuário autenticado (JWT). */
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
  list(@Query() query: FeedQueryDto) {
    return this.feed.list(query);
  }

  @Get('feed/messages/:id')
  @ApiOperation({ summary: 'Detalhe de uma captura' })
  getOne(@Param('id') id: string) {
    return this.feed.getById(id);
  }
}
