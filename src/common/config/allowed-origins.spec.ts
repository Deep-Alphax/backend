/**
 * Testes da fonte única de origens confiáveis (CORS + RequestOriginGuard).
 * Segurança: um falso-positivo aqui libera CSRF/CORS pra origem errada; um
 * falso-negativo quebra o login. Por isso cobrimos os dois lados.
 *
 * A allowlist é CACHEADA no módulo, então cada cenário re-importa o módulo com
 * `jest.resetModules()` após ajustar `process.env` — senão o cache da 1ª carga
 * mascararia mudanças de env.
 */

/** Carrega o módulo do zero com um env específico, driblando o cache interno. */
function loadWith(env: Record<string, string | undefined>) {
  jest.resetModules();
  const prev = { ...process.env };
  // Zera as chaves relevantes p/ o teste não herdar env da máquina/CI.
  delete process.env.FRONTEND_URL;
  delete process.env.CORS_ADDITIONAL_ORIGINS;
  process.env.NODE_ENV = 'production';
  Object.assign(process.env, env);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('./allowed-origins') as typeof import('./allowed-origins');
  return { mod, restore: () => (process.env = prev) };
}

describe('allowed-origins — confiança www ⇄ apex', () => {
  it('libera o www quando só a apex está em FRONTEND_URL', () => {
    const { mod, restore } = loadWith({
      FRONTEND_URL: 'https://deepalpha.fun',
    });
    try {
      expect(mod.isTrustedOrigin('https://deepalpha.fun')).toBe(true);
      expect(mod.isTrustedOrigin('https://www.deepalpha.fun')).toBe(true);
    } finally {
      restore();
    }
  });

  it('libera a apex quando só o www está em FRONTEND_URL', () => {
    const { mod, restore } = loadWith({
      FRONTEND_URL: 'https://www.deepalpha.fun',
    });
    try {
      expect(mod.isTrustedOrigin('https://www.deepalpha.fun')).toBe(true);
      expect(mod.isTrustedOrigin('https://deepalpha.fun')).toBe(true);
    } finally {
      restore();
    }
  });

  it('NÃO deriva outros subdomínios (app./admin.) — só www', () => {
    const { mod, restore } = loadWith({
      FRONTEND_URL: 'https://deepalpha.fun',
    });
    try {
      expect(mod.isTrustedOrigin('https://app.deepalpha.fun')).toBe(false);
      expect(mod.isTrustedOrigin('https://admin.deepalpha.fun')).toBe(false);
    } finally {
      restore();
    }
  });

  it('rejeita origem de domínio totalmente diferente', () => {
    const { mod, restore } = loadWith({
      FRONTEND_URL: 'https://deepalpha.fun',
    });
    try {
      expect(mod.isTrustedOrigin('https://evil.com')).toBe(false);
      // Não pode casar por substring/sufixo enganoso.
      expect(mod.isTrustedOrigin('https://deepalpha.fun.evil.com')).toBe(false);
      expect(mod.isTrustedOrigin('https://notdeepalpha.fun')).toBe(false);
    } finally {
      restore();
    }
  });

  it('distingue esquema e porta (http ≠ https, porta diferente)', () => {
    const { mod, restore } = loadWith({
      FRONTEND_URL: 'https://deepalpha.fun',
    });
    try {
      expect(mod.isTrustedOrigin('http://deepalpha.fun')).toBe(false);
      expect(mod.isTrustedOrigin('https://deepalpha.fun:8443')).toBe(false);
    } finally {
      restore();
    }
  });
});

describe('allowed-origins — normalização e casos gerais', () => {
  it('ignora barra final e espaços na env', () => {
    const { mod, restore } = loadWith({
      FRONTEND_URL: '  https://deepalpha.fun/  ',
    });
    try {
      expect(mod.isTrustedOrigin('https://deepalpha.fun')).toBe(true);
      expect(mod.isTrustedOrigin('https://www.deepalpha.fun')).toBe(true);
    } finally {
      restore();
    }
  });

  it('aceita múltiplas origens em CORS_ADDITIONAL_ORIGINS (CSV)', () => {
    const { mod, restore } = loadWith({
      FRONTEND_URL: 'https://deepalpha.fun',
      CORS_ADDITIONAL_ORIGINS: 'https://painel.deepalpha.fun,https://parceiro.com',
    });
    try {
      expect(mod.isTrustedOrigin('https://painel.deepalpha.fun')).toBe(true);
      expect(mod.isTrustedOrigin('https://parceiro.com')).toBe(true);
      // A contraparte www também vale p/ as extras.
      expect(mod.isTrustedOrigin('https://www.parceiro.com')).toBe(true);
    } finally {
      restore();
    }
  });

  it('localhost dev sempre confiável; origin ausente = não confiável', () => {
    const { mod, restore } = loadWith({ FRONTEND_URL: 'https://deepalpha.fun' });
    try {
      expect(mod.isTrustedOrigin('http://localhost:3000')).toBe(true);
      expect(mod.isTrustedOrigin(undefined)).toBe(false);
    } finally {
      restore();
    }
  });

  it('em development, qualquer *.localhost é confiável (multi-tenant)', () => {
    const { mod, restore } = loadWith({
      NODE_ENV: 'development',
      FRONTEND_URL: 'https://deepalpha.fun',
    });
    try {
      expect(mod.isTrustedOrigin('http://tenant-x.localhost:3000')).toBe(true);
      // Mas host arbitrário em dev continua barrado.
      expect(mod.isTrustedOrigin('https://evil.com')).toBe(false);
    } finally {
      restore();
    }
  });

  it('getAllowedOrigins expõe apex E www juntos', () => {
    const { mod, restore } = loadWith({ FRONTEND_URL: 'https://deepalpha.fun' });
    try {
      const list = mod.getAllowedOrigins();
      expect(list).toContain('https://deepalpha.fun');
      expect(list).toContain('https://www.deepalpha.fun');
    } finally {
      restore();
    }
  });
});
