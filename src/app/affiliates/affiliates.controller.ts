import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';

import { RawResponse } from '../../common/decorators/raw-response.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AffiliatesService } from './affiliates.service';
import { UpdateReferralCodeDto } from './dto/affiliates.dto';

type AuthedRequest = Request & { user: { id: string } };

/**
 * Painel de afiliados do usuário logado.
 *
 * Todo dado é POR CONTA e o `userId` vem do JWT, nunca do corpo ou da query —
 * senão qualquer um leria o extrato (e o faturamento) de outro afiliado.
 */
@ApiTags('Affiliates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@RawResponse()
@Controller('api/v1/affiliates')
export class AffiliatesController {
  constructor(private readonly affiliates: AffiliatesService) {}

  @Get('me')
  @ApiOperation({
    summary: 'Código, link, ganhos e extrato do afiliado logado',
  })
  me(@Req() req: AuthedRequest) {
    return this.affiliates.getOverview(req.user.id);
  }

  @Patch('code')
  @ApiOperation({ summary: 'Troca o código de indicação' })
  @ApiResponse({ status: 400, description: 'Formato inválido' })
  @ApiResponse({ status: 409, description: 'Código já em uso' })
  async updateCode(
    @Req() req: AuthedRequest,
    @Body() dto: UpdateReferralCodeDto,
  ) {
    await this.affiliates.updateCode(req.user.id, dto.code);
    return this.affiliates.getOverview(req.user.id);
  }
}
