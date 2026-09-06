/*
 * Regras PURAS de progresso da mentoria.
 *
 * Ficam fora do serviço de propósito: são o que decide a porcentagem exibida no
 * card, a barra da trilha e o "quanto falta". Função pura é testável sem banco,
 * e ter UM lugar impede que a mesma conta apareça com arredondamento diferente
 * na trilha e na aula.
 */

/** Progresso salvo de uma aula. Ausente = usuário nunca abriu. */
export interface ProgressLike {
  positionSec: number;
  completed: boolean;
}

/** Prende um número no intervalo [min, max]. */
function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Percentual assistido de UMA aula, 0–100 inteiro.
 *
 * Aula marcada como concluída é 100 mesmo que o `positionSec` tenha parado
 * antes do fim — é comum o player não chegar ao último segundo. E aula sem
 * duração cadastrada (`durationSec = 0`) não tem denominador: nesse caso só o
 * flag `completed` responde, senão a divisão viraria Infinity/NaN.
 */
export function lessonPercent(
  progress: ProgressLike | null | undefined,
  durationSec: number,
): number {
  if (!progress) return 0;
  if (progress.completed) return 100;
  if (durationSec <= 0) return 0;
  return Math.round(clamp(progress.positionSec / durationSec, 0, 1) * 100);
}

/**
 * Percentual de uma TRILHA — contado em aulas concluídas, não em segundos
 * assistidos. É o que casa com o "6 de 23 concluídas" da tela: as duas leituras
 * saem da mesma contagem e não podem divergir.
 */
export function modulePercent(completed: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round(clamp(completed / total, 0, 1) * 100);
}

/** Segundos que faltam para terminar a aula. Nunca negativo. */
export function remainingSeconds(
  progress: ProgressLike | null | undefined,
  durationSec: number,
): number {
  if (durationSec <= 0) return 0;
  if (progress?.completed) return 0;
  return Math.max(0, durationSec - (progress?.positionSec ?? 0));
}

/**
 * A aula com que o usuário deve continuar, dentre as candidatas já ordenadas
 * pela ordem da tela (trilha, depois posição).
 *
 * Prioridade: a MAIS RECENTE que foi começada e não terminada. Se o usuário
 * nunca começou nada — ou já terminou tudo que começou —, cai na primeira aula
 * ainda não concluída. `null` só quando não há aula alguma pendente.
 */
export function pickContinueLesson<
  T extends {
    id: string;
    progress: (ProgressLike & { updatedAt: Date }) | null;
  },
>(lessons: readonly T[]): T | null {
  let started: T | null = null;
  let startedAt = 0;

  for (const lesson of lessons) {
    const p = lesson.progress;
    if (!p || p.completed || p.positionSec <= 0) continue;
    const at = p.updatedAt.getTime();
    if (at > startedAt) {
      started = lesson;
      startedAt = at;
    }
  }
  if (started) return started;

  return lessons.find((l) => !l.progress?.completed) ?? null;
}
