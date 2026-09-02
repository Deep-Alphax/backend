import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { RawResponse } from '../../common/decorators/raw-response.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { KolIndexService } from './kol-index.service';
import {
  CreateKolCustomDto,
  ImportKolBackupDto,
  KolQueryDto,
  RenameKolSquadDto,
  UpdateKolOverrideDto,
} from './dto/kol.dto';

/**
 * KOL Index do usuário logado: lê o preset global + as edições da PRÓPRIA conta
 * e escreve só nessas edições. Toda rota é escopada por `req.user.id` — nenhuma
 * delas alcança o preset (isso é `/wallet-reader/admin/*`, sob AdminGuard).
 */
@ApiTags('Wallet Reader')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@RawResponse()
@Controller('api/v1/wallet-reader')
export class KolIndexController {
  constructor(private readonly kols: KolIndexService) {}

  @Get('kols')
  @ApiOperation({
    summary:
      'UMA página do índice, já mesclada (preset + override), filtrada, ' +
      'contada e ordenada no servidor.',
  })
  index(@Request() req, @Query() q: KolQueryDto) {
    return this.kols.getIndex(req.user.id, q);
  }

  // Declarado ANTES de `kols/:kolId`: o Nest casa por ordem, e sem isso
  // "backup" seria lido como um id de KOL.
  @Get('kols/backup')
  @ApiOperation({ summary: 'Backup das edições da conta' })
  backup(@Request() req) {
    return this.kols.exportBackup(req.user.id);
  }

  @Get('kols/:kolId')
  @ApiOperation({ summary: 'Estado efetivo de UM KOL (preset + override)' })
  one(@Request() req, @Param('kolId') kolId: string) {
    return this.kols.getOne(req.user.id, kolId);
  }

  @Post('kols')
  @ApiOperation({ summary: 'Cria um KOL que existe só na conta do usuário' })
  createCustom(@Request() req, @Body() dto: CreateKolCustomDto) {
    return this.kols.createCustom(req.user.id, dto);
  }

  @Post('kols/import')
  @ApiOperation({ summary: 'Restaura um backup na conta (uma chamada)' })
  import(@Request() req, @Body() dto: ImportKolBackupDto) {
    return this.kols.importBackup(req.user.id, dto);
  }

  @Delete('kols')
  @ApiOperation({ summary: 'Apaga TODAS as edições da conta (volta ao preset)' })
  resetAll(@Request() req) {
    return this.kols.resetAll(req.user.id);
  }

  @Patch('kols/:kolId')
  @ApiOperation({ summary: 'Salva as edições do usuário sobre um KOL' })
  @ApiResponse({ status: 404, description: 'KOL fora do preset e da conta' })
  patch(@Request() req, @Param('kolId') kolId: string, @Body() dto: UpdateKolOverrideDto) {
    return this.kols.upsertOverride(req.user.id, kolId, dto);
  }

  @Delete('kols/:kolId')
  @ApiOperation({ summary: 'Descarta as edições do usuário — volta ao preset' })
  reset(@Request() req, @Param('kolId') kolId: string) {
    return this.kols.deleteOverride(req.user.id, kolId);
  }

  // ── Squads da conta ────────────────────────────────────────────────────────
  //
  // Squad não é entidade: é um NOME na lista do override. Não existe rota de
  // criação — marcar um KOL num squad é um PATCH nele. Sobram as duas operações
  // que varrem a conta inteira e que o cliente não faria numa requisição só.
  //
  // Declaradas DEPOIS de `kols/*`: são caminhos distintos, mas manter os blocos
  // separados evita que uma rota nova de `kols/:kolId` capture "squads".

  @Patch('squads')
  @ApiOperation({ summary: 'Renomeia um squad da conta em todos os KOLs dela' })
  renameSquad(@Request() req, @Body() dto: RenameKolSquadDto) {
    return this.kols.renameSquad(req.user.id, dto.from, dto.to);
  }

  @Delete('squads/:name')
  @ApiOperation({ summary: 'Tira um squad da conta de todos os KOLs dela' })
  deleteSquad(@Request() req, @Param('name') name: string) {
    return this.kols.deleteSquad(req.user.id, name);
  }
}
