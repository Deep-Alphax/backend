import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
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
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WalletsService } from './wallets.service';
import { CatalogWalletDto, UpdateWalletDto } from './dto/wallet.dto';

/**
 * Carteiras CATALOGADAS pelo usuário autenticado (multi-wallet, multi-chain). Os dados
 * on-chain são COMPARTILHADOS (carteira canônica por chain+endereço); cada usuário só
 * tem o bookmark. Todas as rotas são escopadas por `req.user.id` via o catálogo.
 */
@ApiTags('Wallets')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/v1/wallets')
export class WalletsController {
  constructor(private readonly walletsService: WalletsService) {}

  @Post()
  @ApiOperation({
    summary: 'Busca/cataloga um endereço público na conta (sem assinatura)',
  })
  @ApiResponse({
    status: 201,
    description: 'Carteira catalogada (syncStatus=PENDING se nova)',
  })
  @ApiResponse({
    status: 400,
    description: 'Endereço inválido ou limite atingido',
  })
  catalog(@Request() req, @Body() dto: CatalogWalletDto) {
    return this.walletsService.catalogWallet(req.user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Lista as carteiras do usuário' })
  @ApiResponse({ status: 200, description: 'Lista de carteiras' })
  findAll(@Request() req) {
    return this.walletsService.findAll(req.user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalha uma carteira' })
  @ApiResponse({ status: 200, description: 'Carteira' })
  @ApiResponse({ status: 404, description: 'Não encontrada' })
  findOne(@Request() req, @Param('id') id: string) {
    return this.walletsService.findOne(req.user.id, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Atualiza rótulo / ativa-desativa a carteira' })
  @ApiResponse({ status: 200, description: 'Carteira atualizada' })
  @ApiResponse({ status: 404, description: 'Não encontrada' })
  update(
    @Request() req,
    @Param('id') id: string,
    @Body() dto: UpdateWalletDto,
  ) {
    return this.walletsService.update(req.user.id, id, dto);
  }

  @Post(':id/resync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reagenda a sincronização da carteira (marca PENDING)',
  })
  @ApiResponse({ status: 200, description: 'Sincronização reagendada' })
  @ApiResponse({ status: 404, description: 'Não encontrada' })
  resync(@Request() req, @Param('id') id: string) {
    return this.walletsService.requestResync(req.user.id, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Remove a carteira (e seus dados de trades/métricas)',
  })
  @ApiResponse({ status: 200, description: 'Carteira removida' })
  @ApiResponse({ status: 404, description: 'Não encontrada' })
  remove(@Request() req, @Param('id') id: string) {
    return this.walletsService.remove(req.user.id, id);
  }
}
