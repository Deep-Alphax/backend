import {
  lessonPercent,
  modulePercent,
  pickContinueLesson,
  remainingSeconds,
} from './progress';

const at = (iso: string) => new Date(iso);

describe('lessonPercent', () => {
  it('é 0 quando o usuário nunca abriu a aula', () => {
    expect(lessonPercent(null, 600)).toBe(0);
    expect(lessonPercent(undefined, 600)).toBe(0);
  });

  it('é a fração assistida, arredondada', () => {
    expect(lessonPercent({ positionSec: 300, completed: false }, 600)).toBe(50);
    expect(lessonPercent({ positionSec: 217, completed: false }, 600)).toBe(36);
  });

  it('é 100 quando concluída, mesmo com o player parado antes do fim', () => {
    // O player raramente chega ao último segundo; o flag é a verdade.
    expect(lessonPercent({ positionSec: 590, completed: true }, 600)).toBe(100);
  });

  it('não passa de 100 nem cai abaixo de 0', () => {
    expect(lessonPercent({ positionSec: 9_000, completed: false }, 600)).toBe(
      100,
    );
    expect(lessonPercent({ positionSec: -50, completed: false }, 600)).toBe(0);
  });

  it('sem duração cadastrada, só o flag responde (nada de divisão por zero)', () => {
    expect(lessonPercent({ positionSec: 120, completed: false }, 0)).toBe(0);
    expect(lessonPercent({ positionSec: 120, completed: true }, 0)).toBe(100);
  });
});

describe('modulePercent', () => {
  it('conta aulas concluídas sobre o total', () => {
    expect(modulePercent(3, 6)).toBe(50);
    expect(modulePercent(6, 6)).toBe(100);
    expect(modulePercent(0, 6)).toBe(0);
  });

  it('trilha vazia é 0, não NaN', () => {
    expect(modulePercent(0, 0)).toBe(0);
  });
});

describe('remainingSeconds', () => {
  it('devolve o que falta', () => {
    expect(remainingSeconds({ positionSec: 240, completed: false }, 600)).toBe(
      360,
    );
  });

  it('é 0 quando concluída ou quando já passou do fim', () => {
    expect(remainingSeconds({ positionSec: 10, completed: true }, 600)).toBe(0);
    expect(remainingSeconds({ positionSec: 900, completed: false }, 600)).toBe(
      0,
    );
  });

  it('é 0 quando não há duração cadastrada', () => {
    expect(remainingSeconds({ positionSec: 120, completed: false }, 0)).toBe(0);
  });
});

describe('pickContinueLesson', () => {
  it('escolhe a começada mais recente que não terminou', () => {
    const lessons = [
      {
        id: 'a',
        progress: {
          positionSec: 10,
          completed: false,
          updatedAt: at('2026-01-01'),
        },
      },
      {
        id: 'b',
        progress: {
          positionSec: 10,
          completed: false,
          updatedAt: at('2026-03-01'),
        },
      },
      {
        id: 'c',
        progress: {
          positionSec: 10,
          completed: false,
          updatedAt: at('2026-02-01'),
        },
      },
    ];
    expect(pickContinueLesson(lessons)?.id).toBe('b');
  });

  it('ignora concluídas mesmo que sejam as mais recentes', () => {
    const lessons = [
      {
        id: 'a',
        progress: {
          positionSec: 10,
          completed: false,
          updatedAt: at('2026-01-01'),
        },
      },
      {
        id: 'b',
        progress: {
          positionSec: 99,
          completed: true,
          updatedAt: at('2026-06-01'),
        },
      },
    ];
    expect(pickContinueLesson(lessons)?.id).toBe('a');
  });

  it('sem nada começado, cai na primeira aula ainda não concluída', () => {
    const lessons = [
      {
        id: 'a',
        progress: {
          positionSec: 0,
          completed: true,
          updatedAt: at('2026-01-01'),
        },
      },
      { id: 'b', progress: null },
      { id: 'c', progress: null },
    ];
    expect(pickContinueLesson(lessons)?.id).toBe('b');
  });

  it('devolve null quando tudo já foi concluído', () => {
    const lessons = [
      {
        id: 'a',
        progress: {
          positionSec: 10,
          completed: true,
          updatedAt: at('2026-01-01'),
        },
      },
    ];
    expect(pickContinueLesson(lessons)).toBeNull();
  });

  it('devolve null quando não há aula alguma', () => {
    expect(pickContinueLesson([])).toBeNull();
  });
});
