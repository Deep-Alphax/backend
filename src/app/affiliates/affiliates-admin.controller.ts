import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { RawResponse } from '../../common/decorators/raw-response.decorator';
import { AdminGuard } from '../auth/guards/admin.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AffiliatesService } from './affiliates.service';
import {
  SetAffiliateRatesDto,
  UpdateAffiliateSettingsDto,
} from './dto/affiliates-admin.dto';

/**
 * Configuração do programa de afiliados — SÓ ADMIN (`JwtAuthGuard` +
 * `AdminGuard`, mesmo padrão do admin da mentoria).
 *
 * Tudo aqui mexe em quanto a empresa paga, então nenhuma destas rotas pode
 * ficar atrás só do login: um afiliado que alcançasse o PATCH de percentual
 * definiria a própria comissão.
 */
@ApiTags('Affiliates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@RawResponse()
@Controller('api/v1/affiliates/admin')
export class AffiliatesAdminController {
  constructor(private readonly affiliates: AffiliatesService) {}

  @Get('settings')
  @ApiOperation({ summary: 'Percentuais padrão do programa' })
  settings() {
    return this.affiliates.getSettings();
  }

  @Patch('settings')
  @ApiOperation({
    summary: 'Troca os percentuais padrão (só vale para comissões futuras)',
  })
  updateSettings(@Body() dto: UpdateAffiliateSettingsDto) {
    return this.affiliates.updateSettings(dto);
  }

  @Get()
  @ApiOperation({ summary: 'Afiliados, com a condição e o total já rendido' })
  list() {
    return this.affiliates.listAffiliates();
  }

  @Patch(':userId/rates')
  @ApiOperation({
    summary:
      'Define a condição negociada de um afiliado (null volta ao padrão)',
  })
  @ApiResponse({ status: 404, description: 'Usuário não encontrado' })
  setRates(@Param('userId') userId: string, @Body() dto: SetAffiliateRatesDto) {
    return this.affiliates.setAffiliateRates(userId, dto);
  }
}
