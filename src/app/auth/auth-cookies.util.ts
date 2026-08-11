import type { Request, Response } from 'express';

/**
 * Cookies de autenticação httpOnly.
 *
 * Motivação (2026-06-10): antes os tokens iam no corpo JSON e o frontend os
 * gravava via `js-cookie` (legível por JS) → XSS poderia roubar a sessão.
 * Agora o backend seta o token em cookie `httpOnly`, invisível ao JS. O front
 * para de gerenciar token; o cookie viaja sozinho (axios `withCredentials`).
 *
 * SameSite=Lax (NÃO Strict): a sessão precisa sobreviver ao retorno de redirects
 * top-level cross-site — o challenge 3DS (ACS do banco) e o callback do Google
 * OAuth voltam por navegação top-level. Com `Strict` o cookie seria descartado
 * nesse retorno e o checkout/login quebraria. `Lax` ainda barra CSRF nos POST
 * cross-site (que é o vetor perigoso).
 *
 * Domain: em produção, app e API são subdomínios distintos
 * (app.* vs api.podioticket.com.br). Para o middleware do front (proxy.ts) ler
 * o cookie no host da app, ele precisa ser de domínio-pai
 * (`COOKIE_DOMAIN=.podioticket.com.br`). Em dev (localhost:porta) o cookie de
 * host já é compartilhado entre portas — deixar `COOKIE_DOMAIN` vazio.
 */

/**
 * Superfícies de sessão ISOLADAS. Cada uma (admin/organizador/cliente) tem seu
 * PRÓPRIO jogo de cookies → as três coexistem no mesmo navegador sem se
 * sobrescrever (logar no admin não derruba o organizador/cliente). Antes havia
 * um cookie ÚNICO compartilhado no domínio-pai, o que misturava as sessões.
 */
export type AuthSurface = 'admin' | 'organizer' | 'client';
const SURFACES: readonly AuthSurface[] = ['admin', 'organizer', 'client'];
const DEFAULT_SURFACE: AuthSurface = 'client';

/** Header enviado pelo front em TODA request declarando a superfície atual. */
export const SURFACE_HEADER = 'x-pt-surface';

/**
 * Resolve a superfície da request pelo header `x-pt-surface`. Fallback p/
 * 'client' (rota anônima, SSR, ou cliente que não envia o header). É o sinal
 * autoritativo de QUAL cookie de sessão usar — não dá pra deduzir do host em dev
 * (tudo em localhost), por isso o front declara explicitamente.
 */
export function resolveAuthSurface(req: Request): AuthSurface {
  const raw = (req?.headers?.[SURFACE_HEADER] as string | undefined)
    ?.toLowerCase()
    .trim();
  return SURFACES.includes(raw as AuthSurface) ? (raw as AuthSurface) : DEFAULT_SURFACE;
}

/** Nomes de cookie por superfície (access/refresh httpOnly + dica não-httpOnly). */
export const accessCookieName = (s: AuthSurface): string => `pt_at_${s}`;
export const refreshCookieName = (s: AuthSurface): string => `pt_rt_${s}`;
/**
 * Cookie-dica de sessão (por superfície): NÃO-httpOnly, NÃO-secreto ("1"). Só
 * sinaliza ao front "provavelmente logado" p/ evitar um GET /profile (401) a cada
 * visita anônima. Não dá acesso a nada — o token de verdade segue httpOnly.
 */
export const sessionHintCookieName = (s: AuthSurface): string => `pt_authed_${s}`;

/**
 * Cookies LEGADOS do modelo antigo (cookie único compartilhado). Limpos no
 * set/clear p/ não "sombrear" os novos por-superfície durante a transição —
 * sessões logadas antes do deploy re-logam 1×.
 */
const LEGACY_SHARED_COOKIES = ['access_token', 'refresh_token'] as const;
const LEGACY_HINT_COOKIE = 'pt_authed';

const ACCESS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias (mirror do legado)
const REFRESH_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 dias

function baseCookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  // Front e API precisam ser SAME-SITE para o cookie fluir com SameSite=Lax:
  //  - PROD: app./api.<domínio> são subdomínios do mesmo site → Lax + COOKIE_DOMAIN
  //    (ex.: `.podioticket.com.br`) cobre todos os subdomínios; Secure (https).
  //  - DEV: rode front e API no MESMO host (localhost:3000 ↔ localhost:3333) ou em
  //    subdomínios de um domínio real de dev (*.lvh.me) com COOKIE_DOMAIN=.lvh.me.
  //    `*.localhost` NÃO funciona: o browser não compartilha cookie entre
  //    `localhost` e `test890.localhost`/`app.localhost`.
  // Em DEV (localhost) o domain DEVE ser host-only (undefined): um cookie com
  // Domain=.podioticket.com.br é DESCARTADO pelo browser quando a página está em
  // `localhost` → a sessão httpOnly nunca é gravada e todo request autenticado
  // (ex.: /auth/profile) responde 401, embora o login retorne 200. Só força o
  // domínio-pai em produção, ou quando COOKIE_DOMAIN é setado explicitamente.
  // Domínio do cookie vem SÓ do env `COOKIE_DOMAIN` (ex.: `.deepalpha.app` em prod para
  // compartilhar a sessão entre app./api.<domínio>). Sem ele, cookie host-only. Não
  // hardcodamos marca aqui — em prod cross-subdomínio, definir COOKIE_DOMAIN.
  const configuredDomain = process.env.COOKIE_DOMAIN?.trim();
  const domain = configuredDomain || undefined;
  // SameSite NÃO é decidido pelo NODE_ENV — é decidido pela TOPOLOGIA (front e API
  // compartilham domínio-pai ou não). O sinal disso é o `COOKIE_DOMAIN`/prod:
  //  - Há domínio-pai (COOKIE_DOMAIN setado OU prod) → front e API são SAME-SITE
  //    (ex.: app./api.podioticket.com.br, inclusive no HOMOLOG rodando como
  //    development). Usa `Lax`: o cookie viaja entre os subdomínios E mantém a
  //    proteção CSRF nos POST cross-site. ESTE é o caminho de qualquer deploy real.
  //  - Sem domínio-pai → dev LOCAL com `tenant.localhost:3000` ↔ `localhost:3333`,
  //    que são CROSS-SITE pro browser (`.localhost` é TLD especial). Aí o `Lax`
  //    barraria o cookie na XHR → precisa de `None` (+ `Secure`, aceito em
  //    `http://localhost` por ser secure-context). Sem domínio-pai = sem CSRF, mas
  //    é só a máquina local, não uma fronteira de segurança.
  // Resultado: homolog (development + COOKIE_DOMAIN) ganha Lax + CSRF, sem precisar
  // virar production. O `None` fica restrito a quem NÃO tem domínio-pai (dev local).
  const sharesParentDomain = !!configuredDomain || isProd;
  const sameSite: 'lax' | 'none' = sharesParentDomain ? 'lax' : 'none';
  // secure: obrigatório em produção (https) e em homolog (COOKIE_DOMAIN). Em dev
  // local (http://localhost) o SameSite é 'none' (front/API cross-site pro browser),
  // e a spec EXIGE `Secure` junto de `SameSite=None` — sem ele o browser DESCARTA o
  // cookie (login "200" mas sessão nunca grava; /profile 401; header fica deslogado).
  // `http://localhost` é secure-context, então aceita `Secure` mesmo sob http. Por
  // isso: secure = true sempre que sameSite==='none'.
  const secure = isProd || !!configuredDomain || sameSite === 'none';
  return {
    httpOnly: true,
    secure,
    sameSite,
    domain,
    path: '/',
  };
}

/** Remove os cookies LEGADOS (modelo de cookie único) p/ não sombrear os novos. */
function clearLegacySharedCookies(res: Response): void {
  const { httpOnly, secure, sameSite, domain, path } = baseCookieOptions();
  const opts = { httpOnly, secure, sameSite, domain, path };
  for (const name of LEGACY_SHARED_COOKIES) res.clearCookie(name, opts);
  res.clearCookie(LEGACY_HINT_COOKIE, { ...opts, httpOnly: false });
}

/** Seta access + refresh token como cookies httpOnly DA SUPERFÍCIE na resposta. */
export function setAuthCookies(
  res: Response,
  surface: AuthSurface,
  accessToken: string,
  refreshToken?: string | null,
): void {
  const base = baseCookieOptions();
  // Limpa o cookie único legado: se persistir, o jwt strategy nem o lê (nomes
  // novos), mas evita confusão/lixo no navegador na 1ª sessão pós-deploy.
  clearLegacySharedCookies(res);
  if (accessToken) {
    res.cookie(accessCookieName(surface), accessToken, {
      ...base,
      maxAge: ACCESS_MAX_AGE_MS,
    });
  }
  if (refreshToken) {
    res.cookie(refreshCookieName(surface), refreshToken, {
      ...base,
      maxAge: REFRESH_MAX_AGE_MS,
    });
  }
  // Dica de sessão legível por JS (sem segredo): o front a usa só para decidir
  // se vale chamar /profile. Mesma janela do refresh.
  res.cookie(sessionHintCookieName(surface), '1', {
    ...base,
    httpOnly: false,
    maxAge: REFRESH_MAX_AGE_MS,
  });
}

/** Limpa os cookies de auth DA SUPERFÍCIE (logout). Mantém as outras sessões. */
export function clearAuthCookies(res: Response, surface: AuthSurface): void {
  const { httpOnly, secure, sameSite, domain, path } = baseCookieOptions();
  const opts = { httpOnly, secure, sameSite, domain, path };
  res.clearCookie(accessCookieName(surface), opts);
  res.clearCookie(refreshCookieName(surface), opts);
  res.clearCookie(sessionHintCookieName(surface), { ...opts, httpOnly: false });
  clearLegacySharedCookies(res);
}

/**
 * Aplica cookies de auth (DA SUPERFÍCIE) a partir de um resultado de login/refresh
 * que carrega `{ data: { access_token, refresh_token } }`. No-op quando o
 * resultado é um desafio MFA (`mfaRequired`) ou não tem tokens. Retorna o próprio
 * resultado para encadear no controller.
 */
export function applyAuthCookiesFromResult<T extends Record<string, any>>(
  res: Response,
  surface: AuthSurface,
  result: T,
): T {
  const data = result?.data ?? result;
  const accessToken = data?.access_token;
  const refreshToken = data?.refresh_token;
  if (accessToken) {
    setAuthCookies(res, surface, accessToken, refreshToken);
  }
  return result;
}
