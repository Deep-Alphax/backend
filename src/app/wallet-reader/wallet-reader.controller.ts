import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
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
  @ApiOperation({ summary: 'Scans de sidewallets cacheados (todos)' })
  scans() {
    return this.service.getScans();
  }

  @Post('scan/:kolId')
  @ApiOperation({ summary: 'Roda a varredura de sidewallets de um KOL (gmgn-cli)' })
  scan(@Param('kolId') kolId: string) {
    return this.service.scanKol(kolId);
  }
}
