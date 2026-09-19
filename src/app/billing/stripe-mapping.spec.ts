import { SubscriptionStatus } from '@prisma/client';
import {
  epochToDate,
  invoiceSubscriptionId,
  mapSubscriptionStatus,
  subscriptionPeriodEnd,
} from './stripe-mapping';

// Formatos reais da API `2026-08-26.dahlia` (conferidos contra o Stripe em modo
// teste): o fim do período vive no ITEM e a assinatura da fatura, em `parent`.
describe('subscriptionPeriodEnd', () => {
  it('lê o fim do período do item (API basil em diante)', () => {
    const sub = { items: { data: [{ current_period_end: 1792362841 }] } };
    expect(subscriptionPeriodEnd(sub)?.getTime()).toBe(1792362841 * 1000);
  });

  it('com vários itens, usa o MENOR fim', () => {
    const sub = {
      items: {
        data: [{ current_period_end: 2000 }, { current_period_end: 1000 }],
      },
    };
    expect(subscriptionPeriodEnd(sub)?.getTime()).toBe(1000 * 1000);
  });

  it('cai no campo do topo para payloads antigos', () => {
    expect(
      subscriptionPeriodEnd({ current_period_end: 1767225600 })?.getTime(),
    ).toBe(1767225600 * 1000);
  });

  it.each([null, undefined, {}, { items: { data: [] } }])(
    'devolve null sem data válida: %p',
    (input) => {
      expect(subscriptionPeriodEnd(input)).toBeNull();
    },
  );
});

describe('invoiceSubscriptionId', () => {
  it('lê de parent.subscription_details (API basil em diante)', () => {
    const invoice = {
      parent: {
        type: 'subscription_details',
        subscription_details: { subscription: 'sub_new' },
      },
    };
    expect(invoiceSubscriptionId(invoice)).toBe('sub_new');
  });

  it('aceita a assinatura expandida como objeto', () => {
    const invoice = {
      parent: { subscription_details: { subscription: { id: 'sub_obj' } } },
    };
    expect(invoiceSubscriptionId(invoice)).toBe('sub_obj');
  });

  it('cai no campo do topo para payloads antigos', () => {
    expect(invoiceSubscriptionId({ subscription: 'sub_old' })).toBe('sub_old');
  });

  it.each([null, {}, { parent: null }])(
    'devolve null para fatura sem assinatura: %p',
    (input) => {
      expect(invoiceSubscriptionId(input)).toBeNull();
    },
  );
});

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
