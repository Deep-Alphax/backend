import { JwtService } from '@nestjs/jwt';

import { OAuthStateService } from './oauth-state.service';

/**
 * O `state` é o único parâmetro que o Google devolve intacto, então é por ele
 * que o destino pós-login e o código de indicação atravessam o consent. Estes
 * testes cobrem o round-trip e, principalmente, o que NÃO pode voltar.
 */
function makeService(secret = 'test-secret') {
  const jwt = new JwtService({});
  const config: any = { get: () => secret };
  return new OAuthStateService(jwt, config);
}

describe('OAuthStateService', () => {
  it('devolve o código de indicação depois da volta do Google', () => {
    const service = makeService();
    const state = service.sign('/plans', 'deep-alpha');
    expect(service.verify(state)).toEqual({
      redirectTo: '/plans',
      referralCode: 'deep-alpha',
    });
  });

  it('normaliza a caixa do código — o link é copiado à mão', () => {
    const service = makeService();
    const state = service.sign(null, 'Deep-Alpha');
    expect(service.verify(state).referralCode).toBe('deep-alpha');
  });

  it('descarta código com formato inválido em vez de derrubar o login', () => {
    const service = makeService();
    // Barra quebraria o link; acento não existe no alfabeto do código.
    expect(
      service.verify(service.sign(null, 'deep/alpha')).referralCode,
    ).toBeNull();
    expect(service.verify(service.sign(null, 'joão')).referralCode).toBeNull();
    expect(service.verify(service.sign(null, 'ab')).referralCode).toBeNull();
  });

  it('não inventa código quando o link não trazia nenhum', () => {
    const service = makeService();
    expect(service.verify(service.sign('/plans')).referralCode).toBeNull();
  });

  it('recusa state assinado com OUTRO segredo (anti-tampering)', () => {
    const attacker = makeService('outro-segredo');
    const ours = makeService();
    const forged = attacker.sign('/plans', 'deep-alpha');
    expect(ours.verify(forged)).toEqual({
      redirectTo: null,
      referralCode: null,
    });
  });

  it('nunca lança — state ausente ou lixo cai no default', () => {
    const service = makeService();
    expect(service.verify(undefined)).toEqual({
      redirectTo: null,
      referralCode: null,
    });
    expect(service.verify('nao-e-um-jwt')).toEqual({
      redirectTo: null,
      referralCode: null,
    });
  });

  it('continua barrando open-redirect no destino', () => {
    const service = makeService();
    const state = service.sign('https://evil.example.com', 'deep-alpha');
    const result = service.verify(state);
    expect(result.redirectTo).toBeNull();
    // O código sobrevive: um destino ruim não é motivo para perder a indicação.
    expect(result.referralCode).toBe('deep-alpha');
  });
});
