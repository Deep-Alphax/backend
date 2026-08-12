/**
 * Segurança do fluxo Google OAuth: o `redirectUri` enviado à troca do code só
 * pode ser o callback do BACKEND (valor único = GOOGLE_CALLBACK_URL). Aceitar
 * qualquer outra coisa reabre superfície de open-redirect / mismatch de consent.
 *
 * Testamos a validação isolando o controller com deps mockadas. Para o caminho
 * ACEITO, mockamos o AuthService p/ lançar um sentinela — se esse sentinela
 * propaga, a validação passou (chegou no service) sem acoplar aos cookies.
 */
import { BadRequestException } from '@nestjs/common';
import { AuthController } from './auth.controller';

const CALLBACK = 'https://api.deepalpha.fun/api/v1/auth/google/callback';

function makeController(reached: jest.Mock) {
  const authService = { validateGoogleCode: reached } as any;
  const oauthState = {} as any;
  const config = {
    get: (key: string) =>
      key === 'GOOGLE_CALLBACK_URL' ? CALLBACK : undefined,
  } as any;
  return new AuthController(authService, oauthState, config);
}

const req = { headers: {} } as any;
const res = { cookie: jest.fn(), clearCookie: jest.fn() } as any;

describe('validateGoogleCode — validação do redirectUri', () => {
  it('rejeita quando falta code ou redirectUri', async () => {
    const ctrl = makeController(jest.fn());
    await expect(
      ctrl.validateGoogleCode(req, { code: '', redirectUri: CALLBACK }, res),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      ctrl.validateGoogleCode(req, { code: 'x', redirectUri: '' }, res),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    ['origem do front (apex)', 'https://deepalpha.fun/api/v1/auth/google/callback'],
    ['origem do front (www)', 'https://www.deepalpha.fun/api/v1/auth/google/callback'],
    ['host correto, path errado', 'https://api.deepalpha.fun/evil'],
    ['domínio malicioso', 'https://evil.com/api/v1/auth/google/callback'],
    ['sufixo enganoso', 'https://api.deepalpha.fun.evil.com/api/v1/auth/google/callback'],
  ])('rejeita redirectUri não-callback: %s', async (_label, redirectUri) => {
    const reached = jest.fn();
    const ctrl = makeController(reached);
    await expect(
      ctrl.validateGoogleCode(req, { code: 'abc', redirectUri }, res),
    ).rejects.toThrow('redirectUri não permitido');
    expect(reached).not.toHaveBeenCalled(); // nem chega no service
  });

  it('aceita o callback exato do backend (chega no service)', async () => {
    const reached = jest.fn().mockRejectedValue(new Error('REACHED_SERVICE'));
    const ctrl = makeController(reached);
    await expect(
      ctrl.validateGoogleCode(req, { code: 'abc', redirectUri: CALLBACK }, res),
    ).rejects.toThrow('REACHED_SERVICE');
    expect(reached).toHaveBeenCalledWith('abc', CALLBACK);
  });

  it('aceita com barra final (normalização)', async () => {
    const reached = jest.fn().mockRejectedValue(new Error('REACHED_SERVICE'));
    const ctrl = makeController(reached);
    await expect(
      ctrl.validateGoogleCode(req, { code: 'abc', redirectUri: `${CALLBACK}/` }, res),
    ).rejects.toThrow('REACHED_SERVICE');
  });
});
