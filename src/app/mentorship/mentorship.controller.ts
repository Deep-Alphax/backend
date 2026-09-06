import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { RawResponse } from '../../common/decorators/raw-response.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ProgressDto } from './dto/mentorship.dto';
import { MentorshipService } from './mentorship.service';

type AuthedRequest = Request & { user: { id: string } };

/**
 * Mentoria — leitura do usuário logado. O progresso é POR CONTA, então toda
 * rota exige sessão; o `userId` vem do JWT e nunca do corpo (senão qualquer um
 * escreveria progresso na conta alheia).
 */
@ApiTags('Mentorship')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@RawResponse()
@Controller('api/v1/mentorship')
export class MentorshipController {
  constructor(private readonly mentorship: MentorshipService) {}

  @Get('overview')
  @ApiOperation({
    summary: 'Trilhas publicadas, aulas e o progresso do usuário logado',
  })
  overview(@Req() req: AuthedRequest) {
    return this.mentorship.getOverview(req.user.id);
  }

  @Patch('lessons/:id/progress')
  @ApiOperation({ summary: 'Salva onde o usuário parou numa aula' })
  progress(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() dto: ProgressDto,
  ) {
    return this.mentorship.saveProgress(req.user.id, id, dto);
  }
}
