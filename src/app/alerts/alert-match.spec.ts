import { AlertKind, Plan } from '@prisma/client';
import {
  matchCapture,
  normalizeRuleValue,
  type CaptureForMatch,
  type MatchContext,
  type RuleForMatch,
} from './alert-match';

const capture: CaptureForMatch = {
  id: 'cap1',
  authorTag: 'ansem',
  channelId: 'ch1',
  channelName: 'calls',
  guildName: 'Alpha Lair',
  text: 'Aping $WIF   right now\nlfg',
};

const rule = (over: Partial<RuleForMatch>): RuleForMatch => ({
  id: 'r1',
  userId: 'u1',
  kind: AlertKind.AUTHOR,
  value: 'ansem',
  label: null,
  ...over,
});

const ctx = (over: Partial<MatchContext> = {}): MatchContext => ({
  plans: new Map([['u1', Plan.PRO]]),
  freeActiveRule: new Map(),
  captureIsFree: false,
  ...over,
});

describe('matchCapture', () => {
  it('autor: casa pelo authorTag exato', () => {
    const [n] = matchCapture(capture, [rule({})], ctx());
    expect(n).toMatchObject({
      userId: 'u1',
      ruleId: 'r1',
      title: 'ansem posted',
    });
    // Espaços colapsados no corpo.
    expect(n.body).toBe('Aping $WIF right now lfg');
  });

  it('canal: casa pelo channelId e mostra o nome do canal', () => {
    const [n] = matchCapture(
      capture,
      [rule({ kind: AlertKind.CHANNEL, value: 'ch1' })],
      ctx(),
    );
    expect(n.title).toBe('New in #calls');
    expect(n.body).toBe('ansem: Aping $WIF right now lfg');
  });

  it('termo: case-insensitive (o valor é gravado em minúsculas)', () => {
    const value = normalizeRuleValue(AlertKind.KEYWORD, '  $wif ');
    const out = matchCapture(
      capture,
      [rule({ kind: AlertKind.KEYWORD, value })],
      ctx(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('"$wif" was mentioned');
  });

  it('não casa o que não é da captura', () => {
    const out = matchCapture(
      capture,
      [
        rule({ id: 'a', value: 'outro' }),
        rule({ id: 'b', kind: AlertKind.CHANNEL, value: 'ch2' }),
        rule({ id: 'c', kind: AlertKind.KEYWORD, value: 'bonk' }),
      ],
      ctx(),
    );
    expect(out).toEqual([]);
  });

  it('várias regras do mesmo usuário → UMA notificação, nomeada pela mais específica', () => {
    const out = matchCapture(
      capture,
      [
        rule({ id: 'kw', kind: AlertKind.KEYWORD, value: 'wif' }),
        rule({ id: 'ch', kind: AlertKind.CHANNEL, value: 'ch1' }),
        rule({ id: 'au', kind: AlertKind.AUTHOR, value: 'ansem' }),
      ],
      ctx(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].ruleId).toBe('au');
  });

  it('usuário sem plano conhecido não recebe (fail-closed)', () => {
    expect(
      matchCapture(capture, [rule({})], ctx({ plans: new Map() })),
    ).toEqual([]);
  });

  describe('FREE', () => {
    const free = (over: Partial<MatchContext> = {}) =>
      ctx({
        plans: new Map([['u1', Plan.FREE]]),
        freeActiveRule: new Map([['u1', 'r1']]),
        captureIsFree: true,
        ...over,
      });

    it('recebe da sua regra em grupo liberado', () => {
      expect(matchCapture(capture, [rule({})], free())).toHaveLength(1);
    });

    it('NÃO recebe de grupo que é só PRO', () => {
      expect(
        matchCapture(capture, [rule({})], free({ captureIsFree: false })),
      ).toEqual([]);
    });

    it('com regras sobrando (caiu do PRO), só a mais antiga dispara', () => {
      const out = matchCapture(
        capture,
        [
          rule({ id: 'r1', kind: AlertKind.KEYWORD, value: 'wif' }),
          rule({ id: 'r2', kind: AlertKind.AUTHOR, value: 'ansem' }),
        ],
        free(),
      );
      expect(out).toHaveLength(1);
      expect(out[0].ruleId).toBe('r1');
    });
  });

  it('entrega a cada usuário separadamente', () => {
    const out = matchCapture(
      capture,
      [rule({ id: 'a', userId: 'u1' }), rule({ id: 'b', userId: 'u2' })],
      ctx({
        plans: new Map([
          ['u1', Plan.PRO],
          ['u2', Plan.PRO],
        ]),
      }),
    );
    expect(out.map((n) => n.userId).sort()).toEqual(['u1', 'u2']);
  });
});
