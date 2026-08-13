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
import { BlacklistService } from './blacklist.service';
import { CreateBlacklistDto, UpdateBlacklistDto } from './dto/blacklist.dto';

/** CRUD da blacklist de usuários (mensagens deles não vão ao Telegram). Só ADMIN. */
@ApiTags('Feed')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('api/v1')
export class BlacklistController {
  constructor(private readonly blacklist: BlacklistService) {}

  @Get('feed/blacklist')
  @ApiOperation({ summary: 'Lista os usuários em blacklist' })
  list() {
    return this.blacklist.list();
  }

  @Post('feed/blacklist')
  @ApiOperation({ summary: 'Adiciona um usuário à blacklist' })
  create(@Body() dto: CreateBlacklistDto) {
    return this.blacklist.create(dto);
  }

  @Patch('feed/blacklist/:id')
  @ApiOperation({ summary: 'Atualiza uma entrada da blacklist' })
  update(@Param('id') id: string, @Body() dto: UpdateBlacklistDto) {
    return this.blacklist.update(id, dto);
  }

  @Delete('feed/blacklist/:id')
  @ApiOperation({ summary: 'Remove uma entrada da blacklist' })
  remove(@Param('id') id: string) {
    return this.blacklist.remove(id);
  }
}
