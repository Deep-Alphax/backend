import {
  DEFAULT_LEVEL1_BPS,
  MAX_RATE_BPS,
  affiliateChain,
  canAttributeReferral,
  commissionCents,
  resolveRateBps,
  generateReferralCode,
  normalizeReferralCode,
  referralCodeError,
  referralLink,
  sumEarnings,
} from './commission';

describe('commissionCents', () => {
  it('é 20% da fatura no plano de US$ 50', () => {
    expect(commissionCents(5_000, DEFAULT_LEVEL1_BPS)).toBe(1_000);
  });

  it('trunca para baixo em vez de arredondar', () => {
    // 20% de 4.999 = 999,8. Arredondar para cima pagaria, na soma de muitas
    // faturas, mais do que a fatia acordada.
    expect(commissionCents(4_999, DEFAULT_LEVEL1_BPS)).toBe(999);
  });

  it('é 0 para fatura sem valor, negativa ou não numérica', () => {
    expect(commissionCents(0, DEFAULT_LEVEL1_BPS)).toBe(0);
    expect(commissionCents(-5_000, DEFAULT_LEVEL1_BPS)).toBe(0);
    expect(commissionCents(Number.NaN, DEFAULT_LEVEL1_BPS)).toBe(0);
  });

  it('é 0 quando a taxa é zero ou inválida — nunca dá dinheiro de graça', () => {
    expect(commissionCents(5_000, 0)).toBe(0);
    expect(commissionCents(5_000, -2_000)).toBe(0);
    expect(commissionCents(5_000, Number.NaN)).toBe(0);
  });

  it('não perde centavo em valores grandes (aritmética inteira)', () => {
    // Com float, 20% de 999.999 escorrega; aqui tem que fechar exato.
    expect(commissionCents(999_999, DEFAULT_LEVEL1_BPS)).toBe(199_999);
  });
});

describe('normalizeReferralCode', () => {
  it('baixa a caixa e tira espaços', () => {
    expect(normalizeReferralCode('  JoAo_2026 ')).toBe('joao_2026');
  });

  it('faz /r/Joao e /r/joao serem o MESMO afiliado', () => {
    expect(normalizeReferralCode('Joao')).toBe(normalizeReferralCode('joao'));
  });
});

describe('referralCodeError', () => {
  it('aceita letras, números, hífen e underscore', () => {
    expect(referralCodeError('deep-alpha_01')).toBeNull();
  });

  it('recusa curto demais e longo demais', () => {
    expect(referralCodeError('ab')).toContain('at least');
    expect(referralCodeError('a'.repeat(25))).toContain('at most');
  });

  it('recusa caractere que quebraria o link', () => {
    expect(referralCodeError('joão')).toContain('only letters');
    expect(referralCodeError('deep/alpha')).toContain('only letters');
    expect(referralCodeError('deep alpha')).toContain('only letters');
  });

  it('valida DEPOIS de normalizar (caixa alta não reprova)', () => {
    expect(referralCodeError('JOAO')).toBeNull();
  });
});

describe('generateReferralCode', () => {
  it('tem o comprimento pedido e só usa o alfabeto seguro', () => {
    const code = generateReferralCode(() => 0.5, 10);
    expect(code).toHaveLength(10);
    expect(code).toMatch(/^[abcdefghijkmnpqrstuvwxyz23456789]+$/);
  });

  it('não gera os caracteres que se confundem ao digitar (0 o 1 l)', () => {
    let seed = 0;
    const code = generateReferralCode(() => {
      seed += 1 / 32;
      return seed % 1;
    }, 200);
    expect(code).not.toMatch(/[01ol]/);
  });

  it('sai válido pelas próprias regras de código', () => {
    expect(referralCodeError(generateReferralCode())).toBeNull();
  });
});

describe('referralLink', () => {
  it('monta o link de cadastro com o código', () => {
    expect(referralLink('https://deepalpha.fun', 'joao')).toBe(
      'https://deepalpha.fun/register?ref=joao',
    );
  });

  it('não duplica a barra quando a base já termina com uma', () => {
    expect(referralLink('https://deepalpha.fun/', 'joao')).toBe(
      'https://deepalpha.fun/register?ref=joao',
    );
  });
});

describe('sumEarnings', () => {
  it('separa o que ainda não foi repassado do total gerado', () => {
    expect(
      sumEarnings([
        { amountCents: 1_000, status: 'PENDING' },
        { amountCents: 1_000, status: 'PAID' },
        { amountCents: 500, status: 'PENDING' },
      ]),
    ).toEqual({ availableCents: 1_500, totalCents: 2_500 });
  });

  it('é zero sem extrato', () => {
    expect(sumEarnings([])).toEqual({ availableCents: 0, totalCents: 0 });
  });

  it('não considera disponível o que já foi pago', () => {
    expect(sumEarnings([{ amountCents: 9_900, status: 'PAID' }])).toEqual({
      availableCents: 0,
      totalCents: 9_900,
    });
  });
});

describe('canAttributeReferral', () => {
  it('recusa autoindicação — a fraude mais barata do programa', () => {
    expect(canAttributeReferral('user_1', 'user_1')).toBe(false);
  });

  it('aceita indicação de outra pessoa', () => {
    expect(canAttributeReferral('user_2', 'user_1')).toBe(true);
  });

  it('recusa quando o código não resolveu para ninguém', () => {
    expect(canAttributeReferral('user_2', null)).toBe(false);
  });
});

describe('resolveRateBps', () => {
  const defaults = { level1Bps: 2000, level2Bps: 500 };

  it('usa o padrão global quando o afiliado não tem exceção', () => {
    expect(resolveRateBps(1, {}, defaults)).toBe(2000);
    expect(resolveRateBps(2, {}, defaults)).toBe(500);
  });

  it('a exceção negociada vence o padrão (o caso do influenciador)', () => {
    expect(resolveRateBps(1, { level1Bps: 3000 }, defaults)).toBe(3000);
    expect(resolveRateBps(2, { level2Bps: 1000 }, defaults)).toBe(1000);
  });

  it('exceção de um nível não vaza para o outro', () => {
    const only1 = { level1Bps: 3000 };
    expect(resolveRateBps(2, only1, defaults)).toBe(500);
  });

  it('0 é valor VÁLIDO e diferente de ausente — zera sem apagar o vínculo', () => {
    expect(resolveRateBps(1, { level1Bps: 0 }, defaults)).toBe(0);
    expect(resolveRateBps(1, { level1Bps: null }, defaults)).toBe(2000);
  });

  it('corta no teto de 100% — erro de digitação não vira preju', () => {
    expect(resolveRateBps(1, { level1Bps: 999_999 }, defaults)).toBe(
      MAX_RATE_BPS,
    );
  });

  it('trata negativo e lixo como zero', () => {
    expect(resolveRateBps(1, { level1Bps: -500 }, defaults)).toBe(0);
    expect(resolveRateBps(1, { level1Bps: Number.NaN }, defaults)).toBe(0);
  });
});

describe('affiliateChain', () => {
  it('paga os dois níveis: quem indicou e quem indicou o indicador', () => {
    // Joel paga -> José (nível 1, indicou direto) e João (nível 2).
    expect(affiliateChain('joel', 'jose', 'joao')).toEqual([
      { affiliateId: 'jose', level: 1 },
      { affiliateId: 'joao', level: 2 },
    ]);
  });

  it('para no nível 1 quando não há avô na cadeia', () => {
    expect(affiliateChain('jose', 'joao', null)).toEqual([
      { affiliateId: 'joao', level: 1 },
    ]);
  });

  it('não paga ninguém quando o pagante não foi indicado', () => {
    expect(affiliateChain('joao', null, null)).toEqual([]);
  });

  it('nunca paga o próprio pagante, em nenhum dos níveis', () => {
    expect(affiliateChain('joao', 'joao', 'jose')).toEqual([
      { affiliateId: 'jose', level: 2 },
    ]);
    expect(affiliateChain('joao', 'jose', 'joao')).toEqual([
      { affiliateId: 'jose', level: 1 },
    ]);
  });

  it('não paga o mesmo afiliado duas vezes pela mesma fatura', () => {
    // Ciclo A->B->A: sem esta trava, quem fecha o laço recebe dobrado.
    expect(affiliateChain('joel', 'jose', 'jose')).toEqual([
      { affiliateId: 'jose', level: 1 },
    ]);
  });
});
