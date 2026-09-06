import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateLessonDto,
  CreateModuleDto,
  ReorderDto,
  UpdateLessonDto,
  UpdateModuleDto,
} from './dto/mentorship.dto';

/** Código do Postgres para violação de UNIQUE (aqui: `slug`). */
const UNIQUE_VIOLATION = 'P2002';

/**
 * CRUD do conteúdo da mentoria — SÓ ADMIN. O que muda aqui muda a tela de todo
 * mundo, então fica separado de `MentorshipService`, que é a leitura do usuário.
 *
 * A ordenação é `position` inteira, atribuída pelo índice na lista enviada. Não
 * usamos "position = max+1" no create porque a tela de admin arrasta e solta: a
 * ordem final vem inteira numa chamada só, dentro de uma transação.
 */
@Injectable()
export class MentorshipAdminService {
  constructor(private readonly prisma: PrismaService) {}

  /** Trilhas com a contagem de aulas — inclui rascunhos (só o admin vê). */
  async listModules() {
    const modules = await this.prisma.mentorshipModule.findMany({
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      include: { _count: { select: { lessons: true } } },
    });
    return modules.map(({ _count, ...m }) => ({
      ...m,
      lessonCount: _count.lessons,
    }));
  }

  /** Uma trilha com as aulas — é o que o editor do admin abre. */
  async getModule(id: string) {
    const module = await this.prisma.mentorshipModule.findUnique({
      where: { id },
      include: {
        lessons: { orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] },
      },
    });
    if (!module) throw new NotFoundException('Trilha não encontrada.');
    return module;
  }

  async createModule(dto: CreateModuleDto) {
    // Nasce no fim da lista; a ordem definitiva vem do `reorderModules`.
    const last = await this.prisma.mentorshipModule.findFirst({
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    try {
      return await this.prisma.mentorshipModule.create({
        data: { ...dto, position: (last?.position ?? -1) + 1 },
      });
    } catch (error) {
      throw this.translateSlugConflict(error, dto.slug);
    }
  }

  async updateModule(id: string, dto: UpdateModuleDto) {
    await this.assertModuleExists(id);
    try {
      return await this.prisma.mentorshipModule.update({
        where: { id },
        data: dto,
      });
    } catch (error) {
      throw this.translateSlugConflict(error, dto.slug);
    }
  }

  /**
   * Apaga a trilha e, por cascata, as aulas e o progresso delas. É destrutivo
   * de propósito: diferente do preset de KOLs, nada externo referencia estes
   * ids sem FK, então não há linha órfã a preservar.
   */
  async deleteModule(id: string) {
    await this.assertModuleExists(id);
    await this.prisma.mentorshipModule.delete({ where: { id } });
    return { deleted: true };
  }

  async createLesson(moduleId: string, dto: CreateLessonDto) {
    await this.assertModuleExists(moduleId);
    const last = await this.prisma.mentorshipLesson.findFirst({
      where: { moduleId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    return this.prisma.mentorshipLesson.create({
      data: { ...dto, moduleId, position: (last?.position ?? -1) + 1 },
    });
  }

  async updateLesson(id: string, dto: UpdateLessonDto) {
    await this.assertLessonExists(id);
    return this.prisma.mentorshipLesson.update({ where: { id }, data: dto });
  }

  async deleteLesson(id: string) {
    await this.assertLessonExists(id);
    await this.prisma.mentorshipLesson.delete({ where: { id } });
    return { deleted: true };
  }

  /**
   * Reordena trilhas: a posição de cada id vira o índice na lista.
   *
   * Numa transação porque uma ordem parcialmente aplicada é pior que nenhuma —
   * a tela ficaria com duas trilhas na mesma posição até alguém arrastar de
   * novo. Ids desconhecidos são ignorados em vez de derrubar a chamada: a lista
   * do admin pode estar um passo atrás de uma exclusão feita em outra aba.
   */
  async reorderModules({ ids }: ReorderDto) {
    const known = await this.prisma.mentorshipModule.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    const valid = new Set(known.map((m) => m.id));
    const ordered = ids.filter((id) => valid.has(id));

    await this.prisma.$transaction(
      ordered.map((id, position) =>
        this.prisma.mentorshipModule.update({
          where: { id },
          data: { position },
        }),
      ),
    );
    return { reordered: ordered.length };
  }

  /** Reordena as aulas DENTRO de uma trilha. Mesma regra do `reorderModules`. */
  async reorderLessons(moduleId: string, { ids }: ReorderDto) {
    await this.assertModuleExists(moduleId);
    const known = await this.prisma.mentorshipLesson.findMany({
      // O filtro por `moduleId` é o que impede mover para cá a aula de outra
      // trilha só mandando o id dela no corpo.
      where: { id: { in: ids }, moduleId },
      select: { id: true },
    });
    const valid = new Set(known.map((l) => l.id));
    const ordered = ids.filter((id) => valid.has(id));

    await this.prisma.$transaction(
      ordered.map((id, position) =>
        this.prisma.mentorshipLesson.update({
          where: { id },
          data: { position },
        }),
      ),
    );
    return { reordered: ordered.length };
  }

  private async assertModuleExists(id: string) {
    const found = await this.prisma.mentorshipModule.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('Trilha não encontrada.');
  }

  private async assertLessonExists(id: string) {
    const found = await this.prisma.mentorshipLesson.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('Aula não encontrada.');
  }

  /**
   * Slug duplicado é erro do usuário do admin, não falha interna: vira 409 com
   * texto acionável em vez do 500 genérico que o P2002 cru produziria.
   */
  private translateSlugConflict(error: unknown, slug?: string): unknown {
    const isUnique =
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === UNIQUE_VIOLATION;
    if (!isUnique) return error;
    return new ConflictException(
      `Já existe uma trilha com o slug "${slug ?? ''}".`,
    );
  }
}
