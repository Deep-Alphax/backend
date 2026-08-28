import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { RawResponse } from '../../common/decorators/raw-response.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { KolIndexService } from './kol-index.service';
import {
  CreateKolPresetDto,
  KolPresetQueryDto,
  UpdateKolPresetDto,
} from './dto/kol.dto';

/**
 * Preset GLOBAL de KOLs — o que todo usuário vê. SÓ ADMIN (JwtAuthGuard +
 * AdminGuard), mesmo padrão de `monitors.controller.ts`. O que muda aqui muda
 * para todo mundo; as edições de cada conta ficam em `/wallet-reader/kols`.
 */
@ApiTags('Wallet Reader')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@RawResponse()
@Controller('api/v1/wallet-reader/admin')
export class KolAdminController {
  constructor(private readonly kols: KolIndexService) {}

  @Get('kols')
  @ApiOperation({
    summary: 'Preset paginado e buscado no banco, incluindo os excluídos',
  })
  list(@Query() q: KolPresetQueryDto) {
    return this.kols.listPreset(q);
  }

  @Get('kols/:id')
  @ApiOperation({ summary: 'Um KOL do preset, com as carteiras (para o editor)' })
  one(@Param('id') id: string) {
    return this.kols.getPreset(id);
  }

  @Post('kols')
  @ApiOperation({ summary: 'Adiciona um KOL ao preset (visível para todos)' })
  create(@Body() dto: CreateKolPresetDto) {
    return this.kols.createPreset(dto);
  }

  @Patch('kols/:id')
  @ApiOperation({ summary: 'Edita um KOL do preset' })
  update(@Param('id') id: string, @Body() dto: UpdateKolPresetDto) {
    return this.kols.updatePreset(id, dto);
  }

  @Delete('kols/:id')
  @ApiOperation({ summary: 'Remove do preset (soft delete)' })
  remove(@Param('id') id: string) {
    return this.kols.removePreset(id);
  }

  @Post('kols/:id/restore')
  @ApiOperation({ summary: 'Restaura um KOL removido do preset' })
  restore(@Param('id') id: string) {
    return this.kols.restorePreset(id);
  }
}
