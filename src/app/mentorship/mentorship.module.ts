import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { MentorshipController } from './mentorship.controller';
import { MentorshipAdminController } from './mentorship-admin.controller';
import { MentorshipService } from './mentorship.service';
import { MentorshipAdminService } from './mentorship-admin.service';

/**
 * Mentoria: trilhas, aulas e progresso.
 *
 * Duas superfícies separadas de propósito — leitura do usuário
 * (`MentorshipService`, sempre filtrada por `published`) e escrita do admin
 * (`MentorshipAdminService`, que enxerga rascunho). Nenhum caminho do usuário
 * passa pelo serviço de escrita.
 */
@Module({
  imports: [PrismaModule],
  controllers: [MentorshipController, MentorshipAdminController],
  providers: [MentorshipService, MentorshipAdminService],
})
export class MentorshipModule {}
