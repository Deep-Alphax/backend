import { AlertKind, Plan } from '@prisma/client';

/**
 * Casamento captura × regras de alerta. Função PURA de propósito: é aqui que se
 * decide quem recebe o quê — inclusive o recorte do FREE —, então precisa ser
 * testável sem banco, sem fila e sem socket.
 */

export interface CaptureForMatch {
  id: string;
  authorTag: string | null;
  channelId: string;
  channelName: string | null;
  guildName: string | null;
  text: string;
}

export interface RuleForMatch {
  id: string;
  userId: string;
  kind: AlertKind;
  value: string;
  label: string | null;
}

export interface MatchContext {
  /** Plano de cada dono de regra candidata. Sem entrada = não entrega. */
  plans: Map<string, Plan>;
  /**
   * FREE: a ÚNICA regra que vale (a mais antiga ativa). Quem caiu de PRO para
   * FREE com várias regras não perde nenhuma — só as outras param de disparar.
   */
  freeActiveRule: Map<string, string>;
  /** A captura é de um grupo liberado para o FREE? */
  captureIsFree: boolean;
}

export interface NotificationDraft {
  userId: string;
  ruleId: string;
  capturedMessageId: string;
  title: string;
  body: string;
}

/** Autor > canal > termo: com várias regras casando, a mais específica nomeia. */
const PRIORITY: Record<AlertKind, number> = {
  [AlertKind.AUTHOR]: 0,
  [AlertKind.CHANNEL]: 1,
  [AlertKind.KEYWORD]: 2,
};

const BODY_MAX = 140;

/** Normaliza o valor de uma regra como ele é gravado e comparado. */
export function normalizeRuleValue(kind: AlertKind, value: string): string {
  const v = value.trim();
  return kind === AlertKind.KEYWORD ? v.toLowerCase() : v;
}

/** A regra casa com a captura? (o banco já pré-filtra; isto é a verdade final) */
export function ruleMatches(rule: RuleForMatch, c: CaptureForMatch): boolean {
  switch (rule.kind) {
    case AlertKind.AUTHOR:
      return c.authorTag !== null && c.authorTag === rule.value;
    case AlertKind.CHANNEL:
      return c.channelId === rule.value;
    case AlertKind.KEYWORD:
      return rule.value.length > 0 && c.text.toLowerCase().includes(rule.value);
  }
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > BODY_MAX ? `${flat.slice(0, BODY_MAX - 1)}…` : flat;
}

function titleFor(rule: RuleForMatch, c: CaptureForMatch): string {
  switch (rule.kind) {
    case AlertKind.AUTHOR:
      return `${rule.label || c.authorTag} posted`;
    case AlertKind.CHANNEL:
      return `New in #${c.channelName ?? rule.label ?? c.channelId}`;
    case AlertKind.KEYWORD:
      return `"${rule.label || rule.value}" was mentioned`;
  }
}

function bodyFor(rule: RuleForMatch, c: CaptureForMatch): string {
  const text = snippet(c.text) || '(no text)';
  // No alerta de autor o título já diz quem foi; nos outros, o autor abre o corpo.
  return rule.kind === AlertKind.AUTHOR || !c.authorTag
    ? text
    : `${c.authorTag}: ${text}`;
}

/**
 * Uma notificação por USUÁRIO (não por regra): três regras do mesmo usuário
 * casando com a mesma captura viram um aviso só, nomeado pela mais específica.
 */
export function matchCapture(
  capture: CaptureForMatch,
  rules: RuleForMatch[],
  ctx: MatchContext,
): NotificationDraft[] {
  const best = new Map<string, RuleForMatch>();

  for (const rule of rules) {
    if (!ruleMatches(rule, capture)) continue;

    const plan = ctx.plans.get(rule.userId);
    if (!plan) continue;
    if (plan === Plan.FREE) {
      // FREE: só grupos liberados, e só a regra que o plano cobre.
      if (!ctx.captureIsFree) continue;
      if (ctx.freeActiveRule.get(rule.userId) !== rule.id) continue;
    }

    const current = best.get(rule.userId);
    if (!current || PRIORITY[rule.kind] < PRIORITY[current.kind]) {
      best.set(rule.userId, rule);
    }
  }

  return [...best.values()].map((rule) => ({
    userId: rule.userId,
    ruleId: rule.id,
    capturedMessageId: capture.id,
    title: titleFor(rule, capture),
    body: bodyFor(rule, capture),
  }));
}
