import { Controller, Get, Param, Query, Request, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { MetricPeriod } from '@prisma/client';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AnalyticsService } from './analytics.service';

class MetricsQueryDto {
  @IsOptional()
  @IsEnum(MetricPeriod)
  period?: MetricPeriod;

  /** Offset do fuso do usuário em minutos p/ os buckets hora/dia (ex.: BRT = -180). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(-720)
  @Max(840)
  tz?: number;

  /** Escopa as métricas a UMA carteira do usuário (ausente = agregado do portfólio). */
  @IsOptional()
  @IsString()
  walletId?: string;
}

/**
 * Analytics de trading do usuário autenticado. Por carteira e agregado (portfólio).
 * `period` ∈ {D30, D90, M12} (default D30); `tz` = offset de minutos do fuso.
 */
@ApiTags('Analytics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/v1')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('wallets/:id/analytics')
  @ApiOperation({ summary: 'Métricas de trading de uma carteira (PnL, hold, buckets, etc.)' })
  @ApiQuery({ name: 'period', enum: MetricPeriod, required: false })
  @ApiQuery({ name: 'tz', required: false, description: 'Offset do fuso em minutos (ex.: -180 = BRT)' })
  @ApiResponse({ status: 200, description: 'Resultado das métricas' })
  @ApiResponse({ status: 404, description: 'Carteira não encontrada' })
  walletAnalytics(@Request() req, @Param('id') id: string, @Query() q: MetricsQueryDto) {
    return this.analytics.walletMetrics(req.user.id, id, q.period ?? MetricPeriod.D30, q.tz ?? 0);
  }

  @Get('analytics/portfolio')
  @ApiOperation({ summary: 'Métricas do perfil: agregado do portfólio, ou de uma carteira (walletId)' })
  @ApiQuery({ name: 'period', enum: MetricPeriod, required: false })
  @ApiQuery({ name: 'tz', required: false, description: 'Offset do fuso em minutos (ex.: -180 = BRT)' })
  @ApiQuery({ name: 'walletId', required: false, description: 'Escopa a uma carteira (ausente = agregado)' })
  @ApiResponse({ status: 200, description: 'Resultado do portfólio ou da carteira' })
  @ApiResponse({ status: 404, description: 'Carteira não encontrada (walletId inválido)' })
  portfolioAnalytics(@Request() req, @Query() q: MetricsQueryDto) {
    return this.analytics.portfolioMetrics(
      req.user.id,
      q.period ?? MetricPeriod.D30,
      q.tz ?? 0,
      q.walletId,
    );
  }
}
