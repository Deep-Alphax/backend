import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Request,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { MetricPeriod } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SourcesService } from './sources.service';
import {
  CreateSourceDto,
  UpdateSourceDto,
  AddSourceWalletDto,
} from './dto/source.dto';

class SourcesQueryDto {
  @IsOptional()
  @IsEnum(MetricPeriod)
  period?: MetricPeriod;

  /** Escopa a tab "Fontes" a UMA carteira (a selecionada). Sem ele → agregado. */
  @IsOptional()
  @IsString()
  walletId?: string;
}

/**
 * Fontes de alpha do usuário autenticado + agregação "De onde vieram os trades".
 * Todas as rotas são escopadas por `req.user.id` (ownership) — sem IDOR.
 */
@ApiTags('Sources')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/v1')
export class SourcesController {
  constructor(private readonly sources: SourcesService) {}

  // ── Agregação (a tab "Fontes" do dashboard) ──
  @Get('analytics/sources')
  @ApiOperation({
    summary:
      'Breakdown de trades por fonte (winrate, saída mediana, capture, PnL, recomendação)',
  })
  @ApiQuery({ name: 'period', enum: MetricPeriod, required: false })
  @ApiResponse({
    status: 200,
    description: 'Lista de fontes com métricas agregadas',
  })
  analytics(@Request() req, @Query() q: SourcesQueryDto) {
    return this.sources.getSourcesAnalytics(
      req.user.id,
      q.period ?? MetricPeriod.D30,
      q.walletId,
    );
  }

  // ── Fontes por DISCORD (cruza trades × calls dos grupos) — a tab "Fontes" ──
  @Get('analytics/discord-sources')
  @ApiOperation({
    summary:
      'De onde vieram os trades: atribuição por servidor do Discord (via calls/CA)',
  })
  @ApiQuery({ name: 'period', enum: MetricPeriod, required: false })
  @ApiResponse({ status: 200, description: 'Fontes (servidores) com métricas' })
  discordAnalytics(@Request() req, @Query() q: SourcesQueryDto) {
    return this.sources.getDiscordSourcesAnalytics(
      req.user.id,
      q.period ?? MetricPeriod.D30,
      q.walletId,
    );
  }

  // ── CRUD de fontes ──
  @Post('sources')
  @ApiOperation({ summary: 'Cadastra uma fonte de alpha' })
  @ApiResponse({ status: 201, description: 'Fonte criada' })
  @ApiResponse({ status: 409, description: 'Nome de fonte já usado' })
  create(@Request() req, @Body() dto: CreateSourceDto) {
    return this.sources.create(req.user.id, dto);
  }

  @Get('sources')
  @ApiOperation({ summary: 'Lista as fontes do usuário' })
  @ApiResponse({ status: 200, description: 'Lista de fontes' })
  findAll(@Request() req) {
    return this.sources.findAll(req.user.id);
  }

  @Get('sources/:id')
  @ApiOperation({ summary: 'Detalha uma fonte (com carteiras)' })
  @ApiResponse({ status: 200, description: 'Fonte' })
  @ApiResponse({ status: 404, description: 'Não encontrada' })
  findOne(@Request() req, @Param('id') id: string) {
    return this.sources.findOne(req.user.id, id);
  }

  @Patch('sources/:id')
  @ApiOperation({ summary: 'Atualiza nome/atividade/janela de atribuição' })
  @ApiResponse({ status: 200, description: 'Fonte atualizada' })
  @ApiResponse({ status: 404, description: 'Não encontrada' })
  update(
    @Request() req,
    @Param('id') id: string,
    @Body() dto: UpdateSourceDto,
  ) {
    return this.sources.update(req.user.id, id, dto);
  }

  @Delete('sources/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a fonte (e suas carteiras/atribuições)' })
  @ApiResponse({ status: 200, description: 'Fonte removida' })
  @ApiResponse({ status: 404, description: 'Não encontrada' })
  remove(@Request() req, @Param('id') id: string) {
    return this.sources.remove(req.user.id, id);
  }

  // ── Carteiras da fonte ──
  @Post('sources/:id/wallets')
  @ApiOperation({
    summary: 'Adiciona uma carteira on-chain à fonte (será sincronizada)',
  })
  @ApiResponse({
    status: 201,
    description: 'Carteira adicionada (syncStatus=PENDING)',
  })
  @ApiResponse({
    status: 400,
    description: 'Endereço inválido ou limite atingido',
  })
  @ApiResponse({
    status: 409,
    description: 'Carteira já cadastrada nesta rede',
  })
  addWallet(
    @Request() req,
    @Param('id') id: string,
    @Body() dto: AddSourceWalletDto,
  ) {
    return this.sources.addWallet(req.user.id, id, dto);
  }

  @Delete('sources/:id/wallets/:walletId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove uma carteira da fonte' })
  @ApiResponse({ status: 200, description: 'Carteira removida' })
  @ApiResponse({ status: 404, description: 'Não encontrada' })
  removeWallet(
    @Request() req,
    @Param('id') id: string,
    @Param('walletId') walletId: string,
  ) {
    return this.sources.removeWallet(req.user.id, id, walletId);
  }
}
