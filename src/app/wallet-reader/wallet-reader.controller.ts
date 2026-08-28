import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WalletReaderService } from './wallet-reader.service';

/** Wallet Reader — varredura de sidewallets/copytraders (JWT). */
@ApiTags('Wallet Reader')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
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
  @ApiOperation({ summary: 'Resultado completo de um scan, com as evidências' })
  scan_one(@Param('kolId') kolId: string) {
    return this.service.getScan(kolId);
  }

  @Post('scan/:kolId')
  @ApiOperation({
    summary:
      'Pede a varredura de sidewallets de um KOL. Responde na hora: devolve o ' +
      'scan em cache se ainda vale, senão enfileira (status "queued") e o ' +
      'resultado chega por socket em `scan:update`. `?force=1` ignora o cache.',
  })
  scan(@Param('kolId') kolId: string, @Query('force') force?: string) {
    return this.service.requestScan(kolId, force === '1' || force === 'true');
  }
}
