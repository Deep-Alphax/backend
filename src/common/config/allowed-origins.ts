/**
 * Fonte ÚNICA das origens confiáveis do front. Usada pelo CORS (`main.ts`) e pelo
 * `RequestOriginGuard` (defesa CSRF stateless) — antes a lista vivia duplicada e
 * desencontrada nos dois lugares.
 *
 * A allowlist é MONTADA A PARTIR DO AMBIENTE (não mais hardcoded), porque a origem
 * do front muda por deploy (dev/homolog/prod) e não pode ser fixada em código:
 *  - `http://localhost:3000`  → sempre presente (dev local).
 *  - `FRONTEND_URL`           → a origem principal do front em prod (ex.:
 *                               `https://deepalpha.fun`). Reaproveita a MESMA env já
 *                               usada no redirect pós-OAuth (auth.controller) — uma
 *                               config só, sem divergir.
 *  - `CORS_ADDITIONAL_ORIGINS`→ origens EXTRAS separadas por vírgula (ex.: o
 *                               `https://www.deepalpha.fun` que redireciona pra raiz,
 *                               um painel admin em outro subdomínio, etc.).
 */

/** Origens sempre confiáveis, independentes de ambiente (dev local). */
const STATIC_ORIGINS: readonly string[] = ['http://localhost:3000'];

/** Normaliza p/ o formato do header `Origin`: sem espaços e sem barra final. */
function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/**
 * Variante `www` ⇄ apex de uma origin. Ex.: `https://deepalpha.fun` ⇄
 * `https://www.deepalpha.fun`. Retorna `null` se a origin for inválida ou se
 * o host não tiver uma contraparte trivial (subdomínios que não sejam `www`
 * NÃO são derivados — evita liberar `app.`/`admin.` sem intenção).
 *
 * Motivo: apex e `www` são o MESMO domínio registrável / mesmo dono; aceitar
 * ambos automaticamente evita quebrar o CORS quando o usuário cai no host
 * "errado" antes do redirect de canonicalização, sem ter que duplicar cada
 * origin em `CORS_ADDITIONAL_ORIGINS`.
 */
function wwwCounterpart(origin: string): string | null {
  try {
    const url = new URL(origin);
    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4); // www.deepalpha.fun → deepalpha.fun
    } else {
      url.hostname = `www.${url.hostname}`; // deepalpha.fun → www.deepalpha.fun
    }
    return normalizeOrigin(url.origin);
  } catch {
    return null;
  }
}

/**
 * Monta a allowlist a partir das envs. Avaliada de forma preguiçosa (ver
 * `getAllowlist`) para garantir que `process.env` já foi carregado — em prod
 * (Docker `env_file`) as envs são do processo desde o boot; a laziness protege o
 * cenário de dev onde o `.env` é lido pelo ConfigModule após o import deste módulo.
 */
function buildAllowlist(): ReadonlySet<string> {
  const fromEnv = [
    process.env.FRONTEND_URL,
    ...(process.env.CORS_ADDITIONAL_ORIGINS?.split(',') ?? []),
  ]
    .map((o) => (o ? normalizeOrigin(o) : ''))
    .filter(Boolean);

  // Cada origin confiável passa a valer também na sua contraparte www⇄apex
  // (mesmo domínio/dono). Assim, definir só `FRONTEND_URL=https://deepalpha.fun`
  // já libera `https://www.deepalpha.fun` — sem duplicar em CORS_ADDITIONAL_ORIGINS.
  const base = [...STATIC_ORIGINS, ...fromEnv];
  const withWww = base.flatMap((o) => {
    const alt = wwwCounterpart(o);
    return alt ? [o, alt] : [o];
  });
  return new Set<string>(withWww);
}

/** Cache da allowlist: as envs são estáticas em runtime, monta uma vez só. */
let cachedAllowlist: ReadonlySet<string> | null = null;
function getAllowlist(): ReadonlySet<string> {
  return (cachedAllowlist ??= buildAllowlist());
}

/**
 * Origens confiáveis (derivadas do ambiente), como array. Função — NÃO const — de
 * propósito: um `const` avaliaria no import, antes do `.env` carregar em dev, e
 * cristalizaria a lista errada. Consumidores devem CHAMAR isto em runtime.
 */
export function getAllowedOrigins(): readonly string[] {
  return [...getAllowlist()];
}

/**
 * Origem é confiável? Em DEV liberamos QUALQUER host `localhost` (os tenants
 * rodam em subdomínios `*.localhost` arbitrários que não dá pra listar). Em prod,
 * só a allowlist exata (STATIC_ORIGINS + FRONTEND_URL + CORS_ADDITIONAL_ORIGINS).
 */
export function isTrustedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  if (getAllowlist().has(normalizeOrigin(origin))) return true;
  if (process.env.NODE_ENV === 'development') {
    try {
      const host = new URL(origin).hostname;
      return host === 'localhost' || host.endsWith('.localhost');
    } catch {
      return false;
    }
  }
  return false;
}
