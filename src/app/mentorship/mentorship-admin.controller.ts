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

import { RawResponse } from '../../common/decorators/raw-response.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { MentorshipAdminService } from './mentorship-admin.service';
import {
  CreateLessonDto,
  CreateModuleDto,
  ReorderDto,
  UpdateLessonDto,
  UpdateModuleDto,
} from './dto/mentorship.dto';

/**
 * Conteúdo da mentoria — SÓ ADMIN (`JwtAuthGuard` + `AdminGuard`, mesmo padrão
 * de `kol-admin.controller.ts`). O que muda aqui aparece para todo usuário.
 */
@ApiTags('Mentorship')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@RawResponse()
@Controller('api/v1/mentorship/admin')
export class MentorshipAdminController {
  constructor(private readonly admin: MentorshipAdminService) {}

  @Get('modules')
  @ApiOperation({ summary: 'Todas as trilhas, inclusive rascunhos' })
  listModules() {
    return this.admin.listModules();
  }

  @Get('modules/:id')
  @ApiOperation({ summary: 'Uma trilha com as aulas (para o editor)' })
  getModule(@Param('id') id: string) {
    return this.admin.getModule(id);
  }

  @Post('modules')
  @ApiOperation({ summary: 'Cria uma trilha' })
  createModule(@Body() dto: CreateModuleDto) {
    return this.admin.createModule(dto);
  }

  // Vem ANTES de `modules/:id` porque o Nest casa as rotas na ordem de
  // declaração — declarada depois, "reorder" cairia no parâmetro `:id`.
  @Patch('modules/reorder')
  @ApiOperation({ summary: 'Reordena as trilhas (posição = índice na lista)' })
  reorderModules(@Body() dto: ReorderDto) {
    return this.admin.reorderModules(dto);
  }

  @Patch('modules/:id')
  @ApiOperation({ summary: 'Edita uma trilha' })
  updateModule(@Param('id') id: string, @Body() dto: UpdateModuleDto) {
    return this.admin.updateModule(id, dto);
  }

  @Delete('modules/:id')
  @ApiOperation({ summary: 'Apaga a trilha, as aulas e o progresso (cascata)' })
  deleteModule(@Param('id') id: string) {
    return this.admin.deleteModule(id);
  }

  @Post('modules/:moduleId/lessons')
  @ApiOperation({ summary: 'Cria uma aula na trilha' })
  createLesson(
    @Param('moduleId') moduleId: string,
    @Body() dto: CreateLessonDto,
  ) {
    return this.admin.createLesson(moduleId, dto);
  }

  @Patch('modules/:moduleId/lessons/reorder')
  @ApiOperation({ summary: 'Reordena as aulas de uma trilha' })
  reorderLessons(@Param('moduleId') moduleId: string, @Body() dto: ReorderDto) {
    return this.admin.reorderLessons(moduleId, dto);
  }

  @Patch('lessons/:id')
  @ApiOperation({ summary: 'Edita uma aula' })
  updateLesson(@Param('id') id: string, @Body() dto: UpdateLessonDto) {
    return this.admin.updateLesson(id, dto);
  }

  @Delete('lessons/:id')
  @ApiOperation({ summary: 'Apaga a aula e o progresso dela (cascata)' })
  deleteLesson(@Param('id') id: string) {
    return this.admin.deleteLesson(id);
  }
}
