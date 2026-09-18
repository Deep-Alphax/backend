/**
 * Regras do programa de afiliados. Funções PURAS: nenhuma conhece Prisma,
 * Stripe ou request — é o que permite testar cada caso de borda de dinheiro
 * sem subir nada.
 */

/**
 * Percentuais PADRÃO, em basis points (2000 = 20%).
 *
 * Em bps e não em `0.2` porque comissão é aritmética de centavos: com float,
 * 20% de 4999 já sai como 999.8000000000001 e a diferença vira erro de
 * arredondamento acumulado no extrato.
 *
 * Nível 1 é quem indicou direto; nível 2 é quem indicou o indicador. O nível 2
 * é custo EXTRA da empresa (paga-se 20% + 5% da mesma fatura), não um pedaço
 * tirado do nível 1 — assim o que um afiliado ganha nunca depende de outro.
 */
export const DEFAULT_LEVEL1_BPS = 2000;
export const DEFAULT_LEVEL2_BPS = 500;

/** Profundidade máxima da cadeia. Dois níveis é a regra do programa. */
export const MAX_LEVEL = 2;

/** Teto de sanidade por nível: 100%. Impede erro de digitação virar preju. */
export const MAX_RATE_BPS = 10_000;

export interface AffiliateRates {
  level1Bps: number;
  level2Bps: number;
}

/**
 * Percentual que vale para ESTE afiliado neste nível.
 *
 * A exceção negociada mora no afiliado (é dele o contrato), o padrão mora nas
 * configurações. `null`/`undefined` no override significa "usa o padrão" —
 * note que 0 é um valor VÁLIDO e diferente de ausente: zera a comissão sem
 * apagar o vínculo.
 */
export function resolveRateBps(
  level: number,
  override: { level1Bps?: number | null; level2Bps?: number | null },
  defaults: AffiliateRates,
): number {
  const own = level === 1 ? override.level1Bps : override.level2Bps;
  const fallback = level === 1 ? defaults.level1Bps : defaults.level2Bps;
  const value = own ?? fallback;
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.trunc(value), MAX_RATE_BPS);
}

/** Um elo da cadeia: quem recebe e em que nível. */
export interface ChainLink {
  affiliateId: string;
  level: number;
}

/**
 * Quem recebe pela fatura de `payerId`, dado quem o indicou (`level1Id`) e
 * quem indicou esse (`level2Id`).
 *
 * Toda a defesa contra abuso mora aqui, testada: ninguém recebe da própria
 * fatura, e o mesmo afiliado não recebe duas vezes pela mesma fatura (o caso
 * do ciclo A→B→A, que pagaria dobrado a quem fechasse o laço).
 */
export function affiliateChain(
  payerId: string,
  level1Id: string | null | undefined,
  level2Id: string | null | undefined,
): ChainLink[] {
  const chain: ChainLink[] = [];
  const seen = new Set<string>([payerId]);

  for (const [level, id] of [
    [1, level1Id],
    [2, level2Id],
  ] as const) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    chain.push({ affiliateId: id, level });
  }
  return chain;
}

/** Formato aceito para o código de indicação. */
export const REFERRAL_CODE_MIN = 4;
export const REFERRAL_CODE_MAX = 24;
const CODE_ALLOWED = /^[a-zA-Z0-9_-]+$/;

/**
 * Comissão de UMA fatura paga, em centavos.
 *
 * Trunca para baixo de propósito: arredondar para cima significaria pagar, na
 * soma de muitas faturas, mais do que a fatia acordada.
 */
export function commissionCents(
  paidAmountCents: number,
  rateBps: number,
): number {
  if (!Number.isFinite(paidAmountCents) || paidAmountCents <= 0) return 0;
  if (!Number.isFinite(rateBps) || rateBps <= 0) return 0;
  return Math.floor((paidAmountCents * rateBps) / 10_000);
}

/**
 * Normaliza um código digitado pelo usuário. Minúsculas porque o link é uma
 * URL e ninguém preserva caixa ao copiar à mão; sem isso, `/r/Joao` e `/r/joao`
 * seriam dois afiliados diferentes disputando a mesma venda.
 */
export function normalizeReferralCode(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Motivo pelo qual um código é inválido, ou null quando serve. */
export function referralCodeError(raw: string): string | null {
  const code = normalizeReferralCode(raw);
  if (code.length < REFERRAL_CODE_MIN) {
    return `The code needs at least ${REFERRAL_CODE_MIN} characters.`;
  }
  if (code.length > REFERRAL_CODE_MAX) {
    return `The code can have at most ${REFERRAL_CODE_MAX} characters.`;
  }
  if (!CODE_ALLOWED.test(code)) {
    return 'Use only letters, numbers, hyphen and underscore.';
  }
  return null;
}

/**
 * Código gerado para quem abre o painel pela primeira vez.
 *
 * Alfabeto sem `0/o/1/l`: o código é lido em voz alta e digitado à mão, e o
 * par que mais gera erro de digitação não paga nada em entropia. 10 caracteres
 * nesse alfabeto dão ~2^49 combinações — colisão é improvável, e o `@unique`
 * do banco cobre o resto (o chamador tenta de novo).
 */
const CODE_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

export function generateReferralCode(
  random: () => number = Math.random,
  length = 10,
): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  }
  return out;
}

/** Link que o afiliado compartilha. */
export function referralLink(appUrl: string, code: string): string {
  const base = appUrl.replace(/\/+$/, '');
  return `${base}/register?ref=${encodeURIComponent(code)}`;
}

export interface CommissionRow {
  amountCents: number;
  status: 'PENDING' | 'PAID';
}

export interface EarningsTotals {
  /** Já apurado e ainda não repassado — é o "Available earnings" da tela. */
  availableCents: number;
  /** Tudo que o afiliado já gerou, pago ou não. */
  totalCents: number;
}

/**
 * Soma o extrato. Recebe as linhas em vez de ir ao banco para que o teste
 * cubra a regra (o que conta como disponível) e não o SQL.
 */
export function sumEarnings(rows: CommissionRow[]): EarningsTotals {
  let availableCents = 0;
  let totalCents = 0;
  for (const row of rows) {
    totalCents += row.amountCents;
    if (row.status === 'PENDING') availableCents += row.amountCents;
  }
  return { availableCents, totalCents };
}

/**
 * Um usuário pode indicar a si mesmo? Não. É a fraude mais barata do programa
 * (criar a segunda conta com o próprio código e ganhar 20% da própria
 * assinatura), então a checagem mora aqui, testada, e não num `if` solto.
 */
export function canAttributeReferral(
  newUserId: string | null,
  affiliateId: string | null,
): boolean {
  if (!affiliateId) return false;
  return newUserId !== affiliateId;
}
