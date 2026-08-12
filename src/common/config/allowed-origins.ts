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
  return new Set<string>([...STATIC_ORIGINS, ...fromEnv]);
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
