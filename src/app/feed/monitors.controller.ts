import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { MonitorsService } from './monitors.service';
import { DiscordMonitorService } from './discord-monitor.service';
import { CreateMonitorDto, UpdateMonitorDto } from './dto/monitor.dto';

/**
 * Gestão das regras de monitoramento + status do self-bot. SÓ ADMIN
 * (JwtAuthGuard + AdminGuard). Toda mutação recarrega o self-bot ao vivo (evento).
 */
@ApiTags('Feed')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('api/v1')
export class MonitorsController {
  constructor(
    private readonly monitors: MonitorsService,
    private readonly discord: DiscordMonitorService,
  ) {}

  @Get('feed/status')
  @ApiOperation({
    summary: 'Status do self-bot (conectado, conta, nº de regras ativas)',
  })
  status() {
    return this.discord.getStatus();
  }

  @Get('feed/monitors')
  @ApiOperation({ summary: 'Lista as regras de monitoramento' })
  list() {
    return this.monitors.list();
  }

  @Post('feed/monitors')
  @ApiOperation({ summary: 'Cria uma regra de monitoramento' })
  create(@Body() dto: CreateMonitorDto) {
    return this.monitors.create(dto);
  }

  @Patch('feed/monitors/:id')
  @ApiOperation({ summary: 'Atualiza uma regra' })
  update(@Param('id') id: string, @Body() dto: UpdateMonitorDto) {
    return this.monitors.update(id, dto);
  }

  @Delete('feed/monitors/:id')
  @ApiOperation({ summary: 'Remove uma regra' })
  remove(@Param('id') id: string) {
    return this.monitors.remove(id);
  }
}
