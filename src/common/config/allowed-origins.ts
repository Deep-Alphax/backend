/**
 * Fonte ÚNICA das origens confiáveis do front. Usada pelo CORS (`main.ts`) e pelo
 * `RequestOriginGuard` (defesa CSRF stateless) — antes a lista vivia duplicada e
 * desencontrada nos dois lugares.
 */
export const ALLOWED_ORIGINS: readonly string[] = [
  'http://localhost:3000',
];

/**
 * Origem é confiável? Em DEV liberamos QUALQUER host `localhost` (os tenants
 * rodam em subdomínios `*.localhost` arbitrários que não dá pra listar). Em prod,
 * só a allowlist exata.
 */
export function isTrustedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
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
