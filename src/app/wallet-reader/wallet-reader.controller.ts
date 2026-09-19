import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Plan } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PlanGuard } from '../billing/guards/plan.guard';
import { RequiresPlan } from '../billing/decorators/requires-plan.decorator';
import { WalletReaderService } from './wallet-reader.service';

/**
 * Wallet Reader — varredura de sidewallets/copytraders (JWT).
 *
 * Controller inteiro é PRO: todo scan é sobre as carteiras de um KOL, e as
 * carteiras são justamente o que o FREE não vê (ver `KolIndexService`).
 */
@ApiTags('Wallet Reader')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlanGuard)
@RequiresPlan(Plan.PRO)
@Controller('api/v1/wallet-reader')
export class WalletReaderController {
  constructor(private readonly service: WalletReaderService) {}

  @Get('scans')
  @ApiOperation({
    summary: 'RESUMO de todos os scans (sem as evidências) — para a listagem',
  })
  scans() {
    return this.service.getScanSummaries();
  }

  @Get('scans/:kolId')
  @ApiOperation({
    summary: 'Varreduras de um KOL (uma por carteira já varrida), com evidências',
  })
  scansOf(@Param('kolId') kolId: string) {
    return this.service.getScansOf(kolId);
  }

  @Post('scan/:kolId')
  @ApiOperation({
    summary:
      'Pede a varredura de UMA carteira do KOL (`?wallet=`; sem ela, a ' +
      'primeira). Responde na hora: devolve o scan em cache se ainda vale, ' +
      'senão enfileira (status "queued") e o resultado chega por socket em ' +
      '`scan:update`. `?force=1` ignora o cache.',
  })
  scan(
    @Param('kolId') kolId: string,
    @Query('wallet') wallet?: string,
    @Query('force') force?: string,
  ) {
    return this.service.requestScan(kolId, wallet, force === '1' || force === 'true');
  }
}
