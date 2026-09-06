import { Plan, SubscriptionStatus } from '@prisma/client';
import {
  effectivePlan,
  isEntitled,
  satisfies,
  type EntitlementInput,
} from './entitlement';

const NOW = new Date('2026-09-05T12:00:00.000Z');
const FUTURE = new Date('2026-10-05T12:00:00.000Z');
const PAST = new Date('2026-08-05T12:00:00.000Z');

function sub(over: Partial<EntitlementInput> = {}): EntitlementInput {
  return {
    plan: Plan.PRO,
    status: SubscriptionStatus.ACTIVE,
    currentPeriodEnd: FUTURE,
    ...over,
  };
}

describe('isEntitled', () => {
  it('concede com ACTIVE dentro do período', () => {
    expect(isEntitled(sub(), NOW)).toBe(true);
  });

  it('concede em TRIALING', () => {
    expect(isEntitled(sub({ status: SubscriptionStatus.TRIALING }), NOW)).toBe(
      true,
    );
  });

  it('NÃO concede sem assinatura', () => {
    expect(isEntitled(null, NOW)).toBe(false);
    expect(isEntitled(undefined, NOW)).toBe(false);
  });

  it.each([
    SubscriptionStatus.INCOMPLETE,
    SubscriptionStatus.PAST_DUE,
    SubscriptionStatus.CANCELED,
  ])('NÃO concede em %s', (status) => {
    expect(isEntitled(sub({ status }), NOW)).toBe(false);
  });

  // A trava que impede PRO vitalício se o webhook de cancelamento se perder.
  it('NÃO concede quando o período já venceu, mesmo ACTIVE', () => {
    expect(isEntitled(sub({ currentPeriodEnd: PAST }), NOW)).toBe(false);
  });

  it('trata o instante exato do fim como vencido', () => {
    expect(isEntitled(sub({ currentPeriodEnd: NOW }), NOW)).toBe(false);
  });

  it('concede sem data de fim (ACTIVE recém-criada pelo provedor)', () => {
    expect(isEntitled(sub({ currentPeriodEnd: null }), NOW)).toBe(true);
  });
});

describe('effectivePlan', () => {
  it('cai para FREE sem assinatura', () => {
    expect(effectivePlan(null, NOW)).toBe(Plan.FREE);
  });

  it('cai para FREE com assinatura vencida', () => {
    expect(effectivePlan(sub({ currentPeriodEnd: PAST }), NOW)).toBe(Plan.FREE);
  });

  it('devolve o plano da assinatura viva', () => {
    expect(effectivePlan(sub(), NOW)).toBe(Plan.PRO);
  });
});

describe('satisfies', () => {
  it('PRO satisfaz exigência de FREE e de PRO', () => {
    expect(satisfies(Plan.PRO, Plan.FREE)).toBe(true);
    expect(satisfies(Plan.PRO, Plan.PRO)).toBe(true);
  });

  it('FREE não satisfaz exigência de PRO', () => {
    expect(satisfies(Plan.FREE, Plan.PRO)).toBe(false);
  });
});
