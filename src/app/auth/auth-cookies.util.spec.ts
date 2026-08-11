import {
  setAuthCookies,
  clearAuthCookies,
  applyAuthCookiesFromResult,
} from './auth-cookies.util';

/** Response falso que captura as chamadas de cookie/clearCookie. */
function mockRes() {
  return { cookie: jest.fn(), clearCookie: jest.fn() } as any;
}

/** Options passadas ao `res.cookie(name, value, options)` para um cookie. */
function optionsFor(res: any, name: string): any {
  const call = res.cookie.mock.calls.find((c: any[]) => c[0] === name);
  return call?.[2];
}

const setEnv = (nodeEnv: string, cookieDomain?: string) => {
  (process.env as any).NODE_ENV = nodeEnv;
  if (cookieDomain === undefined) delete process.env.COOKIE_DOMAIN;
  else process.env.COOKIE_DOMAIN = cookieDomain;
};

describe('auth-cookies.util', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.clearAllMocks();
  });

  // ── O bug de 2026-08-11: dev local gerava SameSite=None SEM Secure → o browser
  // descartava TODOS os cookies (login 200, mas sessão nunca gravava; /profile 401;
  // header ficava "Entrar" mesmo após login Google). ──
  describe('dev local (sem COOKIE_DOMAIN)', () => {
    it('usa SameSite=None e, por exigência da spec, Secure=true (senão o cookie é rejeitado)', () => {
      setEnv('development', undefined);
      const res = mockRes();
      setAuthCookies(res, 'client', 'access-tok', 'refresh-tok');

      const hint = optionsFor(res, 'pt_authed_client');
      expect(hint.sameSite).toBe('none');
      expect(hint.secure).toBe(true); // regressão-guard do bug
      expect(hint.httpOnly).toBe(false); // dica precisa ser legível por JS
    });

    it('access/refresh são httpOnly e Secure', () => {
      setEnv('development', undefined);
      const res = mockRes();
      setAuthCookies(res, 'client', 'access-tok', 'refresh-tok');

      const access = optionsFor(res, 'pt_at_client');
      const refresh = optionsFor(res, 'pt_rt_client');
      expect(access.httpOnly).toBe(true);
      expect(access.secure).toBe(true);
      expect(refresh.httpOnly).toBe(true);
      expect(refresh.secure).toBe(true);
    });
  });

  // Invariante universal (independe de env): SameSite=None SEMPRE com Secure.
  it.each([
    ['development', undefined],
    ['production', undefined],
    ['development', '.deepalpha.app'],
    ['production', '.deepalpha.app'],
  ])('INVARIANTE (NODE_ENV=%s, COOKIE_DOMAIN=%s): sameSite==="none" ⇒ secure===true', (env, domain) => {
    setEnv(env, domain as string | undefined);
    const res = mockRes();
    setAuthCookies(res, 'client', 'access-tok', 'refresh-tok');

    for (const call of res.cookie.mock.calls) {
      const opts = call[2];
      if (opts?.sameSite === 'none') {
        expect(opts.secure).toBe(true);
      }
    }
  });

  describe('homolog/prod (com domínio-pai)', () => {
    it('COOKIE_DOMAIN → SameSite=Lax + Secure + domain propagado', () => {
      setEnv('development', '.deepalpha.app');
      const res = mockRes();
      setAuthCookies(res, 'client', 'access-tok', 'refresh-tok');

      const hint = optionsFor(res, 'pt_authed_client');
      expect(hint.sameSite).toBe('lax');
      expect(hint.secure).toBe(true);
      expect(hint.domain).toBe('.deepalpha.app');
    });

    it('produção → SameSite=Lax + Secure', () => {
      setEnv('production', undefined);
      const res = mockRes();
      setAuthCookies(res, 'client', 'access-tok', 'refresh-tok');

      const hint = optionsFor(res, 'pt_authed_client');
      expect(hint.sameSite).toBe('lax');
      expect(hint.secure).toBe(true);
    });
  });

  describe('contrato do cookie-dica (consumido pelo frontend useSession/middleware)', () => {
    it('nome por-superfície e valor exatamente "1"', () => {
      setEnv('development', undefined);
      const res = mockRes();
      setAuthCookies(res, 'client', 'access-tok', 'refresh-tok');

      const call = res.cookie.mock.calls.find((c: any[]) => c[0] === 'pt_authed_client');
      expect(call).toBeDefined();
      expect(call[1]).toBe('1'); // hasSessionHint() casa exatamente "pt_authed_client=1"
      expect(call[2].httpOnly).toBe(false);
    });

    it('superfície admin usa outro nome (isolamento entre sessões)', () => {
      setEnv('development', undefined);
      const res = mockRes();
      setAuthCookies(res, 'admin', 'access-tok', 'refresh-tok');

      expect(optionsFor(res, 'pt_at_admin')).toBeDefined();
      const hintCall = res.cookie.mock.calls.find((c: any[]) => c[0] === 'pt_authed_admin');
      expect(hintCall?.[1]).toBe('1');
    });
  });

  describe('applyAuthCookiesFromResult', () => {
    it('seta cookies quando o resultado tem access_token', () => {
      setEnv('development', undefined);
      const res = mockRes();
      applyAuthCookiesFromResult(res, 'client', {
        data: { access_token: 'atk', refresh_token: 'rtk' },
      } as any);
      expect(optionsFor(res, 'pt_at_client')).toBeDefined();
      expect(res.cookie.mock.calls.some((c: any[]) => c[0] === 'pt_authed_client')).toBe(true);
    });

    it('NO-OP em desafio MFA (sem access_token) — não seta cookie de sessão', () => {
      setEnv('development', undefined);
      const res = mockRes();
      applyAuthCookiesFromResult(res, 'client', { mfaRequired: true, mfaToken: 'x' } as any);
      expect(res.cookie).not.toHaveBeenCalled();
    });
  });

  describe('clearAuthCookies', () => {
    it('limpa access/refresh/hint da superfície', () => {
      setEnv('development', undefined);
      const res = mockRes();
      clearAuthCookies(res, 'client');
      const cleared = res.clearCookie.mock.calls.map((c: any[]) => c[0]);
      expect(cleared).toEqual(
        expect.arrayContaining(['pt_at_client', 'pt_rt_client', 'pt_authed_client']),
      );
    });
  });
});
