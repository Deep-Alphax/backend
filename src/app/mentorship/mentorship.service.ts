import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { MentorshipAccent } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ProgressDto } from './dto/mentorship.dto';
import {
  lessonPercent,
  modulePercent,
  pickContinueLesson,
  remainingSeconds,
} from './progress';
import MENTORSHIP_SEED from './data/mentorship-seed.json';

/** Uma trilha do JSON de seed. */
interface SeedModule {
  slug: string;
  title: string;
  label: string;
  subtitle: string;
  coverUrl: string;
  accent: string;
  lessons: {
    title: string;
    description: string;
    durationSec: number;
    coverUrl: string;
  }[];
}

/** Aula como a tela consome. Duração em segundos — o front formata. */
export interface OverviewLesson {
  id: string;
  title: string;
  description: string;
  episode: number;
  durationSec: number;
  coverUrl: string;
  videoUrl: string;
  moduleId: string;
  moduleTitle: string;
  /** Onde o usuário parou e quanto disso é, em %. */
  positionSec: number;
  completed: boolean;
  percent: number;
}

export interface OverviewModule {
  id: string;
  slug: string;
  title: string;
  subtitle: string;
  label: string;
  coverUrl: string;
  accent: MentorshipAccent;
  lessonCount: number;
  totalDurationSec: number;
  completedCount: number;
  percent: number;
  lessons: OverviewLesson[];
}

export interface MentorshipOverview {
  modules: OverviewModule[];
  totals: { lessons: number; completed: number; modules: number };
  /** Aula do card "Continue where you left off". `null` = tudo concluído. */
  continueLesson: (OverviewLesson & { remainingSec: number }) | null;
}

@Injectable()
export class MentorshipService implements OnModuleInit {
  private readonly logger = new Logger(MentorshipService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Semeia o conteúdo inicial a partir do JSON — 1×, só com a tabela vazia
   * (mesmo padrão de `KolIndexService`). Depois disso quem manda é a tela de
   * admin: o seed nunca sobrescreve o que já existe.
   */
  async onModuleInit(): Promise<void> {
    try {
      const count = await this.prisma.mentorshipModule.count();
      if (count > 0) return;
      const seed = MENTORSHIP_SEED as SeedModule[];
      if (!seed?.length) return;

      for (const [position, m] of seed.entries()) {
        await this.prisma.mentorshipModule.create({
          data: {
            slug: m.slug,
            title: m.title,
            label: m.label,
            subtitle: m.subtitle,
            coverUrl: m.coverUrl,
            accent: m.accent as MentorshipAccent,
            position,
            lessons: {
              create: m.lessons.map((l, i) => ({
                title: l.title,
                description: l.description,
                durationSec: l.durationSec,
                coverUrl: l.coverUrl,
                episode: i + 1,
                position: i,
              })),
            },
          },
        });
      }
      const lessons = seed.reduce((n, m) => n + m.lessons.length, 0);
      this.logger.log(
        `Seed da mentoria: ${seed.length} trilhas, ${lessons} aulas.`,
      );
    } catch (e: any) {
      // Falhar o seed não pode derrubar o boot: sem conteúdo a tela mostra o
      // estado vazio e o admin cadastra à mão.
      this.logger.warn(`Falha no seed da mentoria: ${e?.message}`);
    }
  }

  /**
   * Tudo o que a tela de mentoria precisa, em DUAS queries.
   *
   * A segunda busca o progresso do usuário pelos ids já carregados — não uma
   * por aula. Com 4 trilhas × 6 aulas o N+1 seria 24 idas ao banco por abertura
   * de tela; aqui é uma só, com `lessonId IN (...)` batendo no índice único
   * `(userId, lessonId)`.
   *
   * De propósito NÃO usa `getReadClient()`: o progresso é gravado e relido no
   * mesmo gesto do usuário, e o lag da réplica mostraria a barra andando para
   * trás logo depois de salvar. O volume aqui é pequeno e limitado (trilhas
   * publicadas × aulas publicadas), então a réplica não compraria nada.
   */
  async getOverview(userId: string): Promise<MentorshipOverview> {
    const modules = await this.prisma.mentorshipModule.findMany({
      where: { published: true },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      include: {
        lessons: {
          where: { published: true },
          orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });

    const lessonIds = modules.flatMap((m) => m.lessons.map((l) => l.id));
    const progressRows = lessonIds.length
      ? await this.prisma.lessonProgress.findMany({
          where: { userId, lessonId: { in: lessonIds } },
          select: {
            lessonId: true,
            positionSec: true,
            completed: true,
            updatedAt: true,
          },
        })
      : [];
    const progressByLesson = new Map(progressRows.map((p) => [p.lessonId, p]));

    // Lista achatada na ORDEM DA TELA — é ela que decide qual aula é a "próxima"
    // quando o usuário ainda não começou nada.
    const flat: {
      lesson: OverviewLesson;
      progress: {
        positionSec: number;
        completed: boolean;
        updatedAt: Date;
      } | null;
      id: string;
    }[] = [];

    const overviewModules: OverviewModule[] = modules.map((m) => {
      let completedCount = 0;
      let totalDurationSec = 0;

      const lessons = m.lessons.map((l) => {
        const p = progressByLesson.get(l.id) ?? null;
        if (p?.completed) completedCount += 1;
        totalDurationSec += l.durationSec;

        const lesson: OverviewLesson = {
          id: l.id,
          title: l.title,
          description: l.description,
          episode: l.episode,
          durationSec: l.durationSec,
          coverUrl: l.coverUrl,
          videoUrl: l.videoUrl,
          moduleId: m.id,
          moduleTitle: m.title,
          positionSec: p?.positionSec ?? 0,
          completed: p?.completed ?? false,
          percent: lessonPercent(p, l.durationSec),
        };
        flat.push({ id: l.id, lesson, progress: p });
        return lesson;
      });

      return {
        id: m.id,
        slug: m.slug,
        title: m.title,
        subtitle: m.subtitle,
        label: m.label,
        coverUrl: m.coverUrl,
        accent: m.accent,
        lessonCount: lessons.length,
        totalDurationSec,
        completedCount,
        percent: modulePercent(completedCount, lessons.length),
        lessons,
      };
    });

    const picked = pickContinueLesson(flat);
    const continueLesson = picked
      ? {
          ...picked.lesson,
          remainingSec: remainingSeconds(
            picked.progress,
            picked.lesson.durationSec,
          ),
        }
      : null;

    return {
      modules: overviewModules,
      totals: {
        modules: overviewModules.length,
        lessons: flat.length,
        completed: flat.filter((f) => f.progress?.completed).length,
      },
      continueLesson,
    };
  }

  /**
   * Grava onde o usuário parou.
   *
   * A posição é PRESA à duração real da aula, lida do banco: o corpo vem do
   * cliente e não é autoridade sobre quanto ele assistiu. Passar do fim conta
   * como concluída — é o que o player reporta ao terminar.
   *
   * `upsert` no índice único `(userId, lessonId)` mantém a operação idempotente:
   * o player manda heartbeat repetido e retry de rede não duplica linha.
   */
  async saveProgress(userId: string, lessonId: string, dto: ProgressDto) {
    const lesson = await this.prisma.mentorshipLesson.findFirst({
      where: { id: lessonId, published: true, module: { published: true } },
      select: { id: true, durationSec: true },
    });
    if (!lesson) throw new NotFoundException('Aula não encontrada.');

    const raw = dto.positionSec ?? 0;
    const positionSec =
      lesson.durationSec > 0 ? Math.min(raw, lesson.durationSec) : raw;
    const completed =
      dto.completed ?? (lesson.durationSec > 0 && raw >= lesson.durationSec);

    // `completedAt` marca a PRIMEIRA conclusão: reassistir não reescreve a data.
    // Ler antes é mais barato que expressar COALESCE num upsert — e deixa a
    // regra explícita em vez de escondida num `set: undefined`.
    const existing = await this.prisma.lessonProgress.findUnique({
      where: { userId_lessonId: { userId, lessonId } },
      select: { completedAt: true },
    });
    const completedAt = completed
      ? (existing?.completedAt ?? new Date())
      : null;

    const row = await this.prisma.lessonProgress.upsert({
      where: { userId_lessonId: { userId, lessonId } },
      create: { userId, lessonId, positionSec, completed, completedAt },
      update: { positionSec, completed, completedAt },
      select: { positionSec: true, completed: true },
    });

    return {
      lessonId,
      positionSec: row.positionSec,
      completed: row.completed,
      percent: lessonPercent(row, lesson.durationSec),
    };
  }
}
