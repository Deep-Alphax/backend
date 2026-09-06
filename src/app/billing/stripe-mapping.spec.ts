import { SubscriptionStatus } from '@prisma/client';
import { epochToDate, mapSubscriptionStatus } from './stripe-mapping';

describe('mapSubscriptionStatus', () => {
  it.each([
    ['active', SubscriptionStatus.ACTIVE],
    ['trialing', SubscriptionStatus.TRIALING],
    ['past_due', SubscriptionStatus.PAST_DUE],
    ['unpaid', SubscriptionStatus.PAST_DUE],
    ['paused', SubscriptionStatus.PAST_DUE],
    ['canceled', SubscriptionStatus.CANCELED],
    ['incomplete_expired', SubscriptionStatus.CANCELED],
    ['incomplete', SubscriptionStatus.INCOMPLETE],
  ])('%s → %s', (input, expected) => {
    expect(mapSubscriptionStatus(input)).toBe(expected);
  });

  // A trava que importa: status novo do Stripe não pode virar acesso liberado.
  it.each(['', 'status_que_ainda_nao_existe', 'ACTIVE', 'ativo'])(
    'cai em INCOMPLETE (não concede) para status desconhecido: %p',
    (input) => {
      expect(mapSubscriptionStatus(input)).toBe(SubscriptionStatus.INCOMPLETE);
    },
  );
});

describe('epochToDate', () => {
  it('converte segundos para Date', () => {
    expect(epochToDate(1767225600)?.toISOString()).toBe(
      new Date(1767225600 * 1000).toISOString(),
    );
  });

  it.each([null, undefined, 0, -1, NaN, Infinity, '1767225600', {}])(
    'devolve null para entrada inválida: %p',
    (input) => {
      expect(epochToDate(input)).toBeNull();
    },
  );
});
