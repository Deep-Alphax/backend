import { BadRequestException, ConflictException, HttpException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';

function makeService() {
  const store = new Map<string, any>();
  const cache: any = {
    get: jest.fn((k: string) => Promise.resolve(store.has(k) ? store.get(k) : undefined)),
    set: jest.fn((k: string, v: any) => {
      store.set(k, v);
      return Promise.resolve();
    }),
    del: jest.fn((k: string) => {
      store.delete(k);
      return Promise.resolve();
    }),
  };
  const client = {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const prisma: any = { getReadClient: () => client, getWriteClient: () => client };
  const cfg: Record<string, string> = { JWT_SECRET: 'secret', JWT_EXPIRES_IN: '30d' };
  const config: any = { get: jest.fn((k: string, d?: any) => cfg[k] ?? d) };
  const jwt: any = {
    sign: jest.fn(() => 'signed-token'),
    verify: jest.fn(),
    decode: jest.fn(),
  };
  const http: any = { get: jest.fn(), post: jest.fn() };
  const email: any = {
    sendWelcomeUser: jest.fn().mockResolvedValue(undefined),
    send2FACode: jest.fn().mockResolvedValue(undefined),
    sendPasswordResetCode: jest.fn().mockResolvedValue(undefined),
    sendPasswordChangedNotification: jest.fn().mockResolvedValue(undefined),
  };
  // UsersService: só o fluxo Google usa; devolve o usuário sem alterar (avatar).
  const users: any = { hydrateGoogleAvatar: jest.fn((u: any) => Promise.resolve(u)) };
  const service = new AuthService(jwt, config, prisma, cache, http, email, users);
  return { service, client, cache, store, jwt, email, config, users };
}

describe('AuthService', () => {
  describe('validateUser', () => {
    it('retorna o usuário sem a senha quando as credenciais batem', async () => {
      const { service, client } = makeService();
      const password = 'Password1';
      const hash = await bcrypt.hash(password, 4);
      client.user.findUnique.mockResolvedValue({
        id: 'u1', email: 'a@b.com', password: hash, isActive: true, deletedAt: null,
        firstName: 'A', lastName: 'B', avatarUrl: null, role: 'USER', mfaEnabled: false,
      });
      const res = await service.validateUser('a@b.com', password);
      expect(res.id).toBe('u1');
      expect(res.password).toBeUndefined();
    });

    it('retorna null e incrementa o lockout quando a senha está errada', async () => {
      const { service, client, cache } = makeService();
      const hash = await bcrypt.hash('correct', 4);
      client.user.findUnique.mockResolvedValue({
        id: 'u1', email: 'a@b.com', password: hash, isActive: true, deletedAt: null,
      });
      const res = await service.validateUser('a@b.com', 'wrong');
      expect(res).toBeNull();
      expect(cache.set).toHaveBeenCalledWith('login_fail:a@b.com', 1, expect.any(Number));
    });

    it('trava (429) após exceder o limite de falhas', async () => {
      const { service, store } = makeService();
      store.set('login_fail:a@b.com', 8);
      await expect(service.validateUser('a@b.com', 'x')).rejects.toBeInstanceOf(HttpException);
    });

    it('retorna null para conta inativa/excluída', async () => {
      const { service, client } = makeService();
      client.user.findUnique.mockResolvedValue({ id: 'u1', password: 'h', isActive: false, deletedAt: null });
      expect(await service.validateUser('a@b.com', 'x')).toBeNull();
    });
  });

  describe('register', () => {
    it('rejeita sem aceite dos termos', async () => {
      const { service } = makeService();
      await expect(
        service.register({ email: 'a@b.com', password: 'Password1', complete_name: 'A B', acceptedTerms: false, acceptedPrivacyPolicy: true } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejeita e-mail duplicado com Conflict', async () => {
      const { service, client } = makeService();
      client.user.findUnique.mockResolvedValue({ id: 'exists' });
      await expect(
        service.register({ email: 'a@b.com', password: 'Password1', complete_name: 'A B', acceptedTerms: true, acceptedPrivacyPolicy: true } as any),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('cria a conta, envia boas-vindas e autologa (sem MFA)', async () => {
      const { service, client, email } = makeService();
      client.user.findUnique.mockResolvedValue(null);
      client.user.create.mockResolvedValue({
        id: 'u1', email: 'a@b.com', firstName: 'A', lastName: 'B', avatarUrl: null, role: 'USER', mfaEnabled: false,
      });
      const res: any = await service.register({
        email: 'A@B.com', password: 'Password1', complete_name: 'A B', acceptedTerms: true, acceptedPrivacyPolicy: true,
      } as any);
      expect(client.user.create.mock.calls[0][0].data.email).toBe('a@b.com'); // normalizado
      expect(email.sendWelcomeUser).toHaveBeenCalled();
      expect(res.data.access_token).toBe('signed-token');
    });
  });

  describe('login', () => {
    it('emite challenge MFA quando mfaEnabled', async () => {
      const { service, email } = makeService();
      const res: any = await service.login({ id: 'u1', email: 'a@b.com', mfaEnabled: true });
      expect(res.mfaRequired).toBe(true);
      expect(res.mfaToken).toBeDefined();
      expect(email.send2FACode).toHaveBeenCalled();
    });

    it('emite tokens e atualiza lastLoginAt sem MFA', async () => {
      const { service, client } = makeService();
      const res: any = await service.login({ id: 'u1', email: 'a@b.com', mfaEnabled: false, firstName: 'A', role: 'USER' });
      expect(res.data.access_token).toBe('signed-token');
      expect(res.data.refresh_token).toBe('signed-token');
      expect(client.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: { lastLoginAt: expect.any(Date) } }));
    });
  });

  describe('2FA (verifyAndConsume via enable2FA)', () => {
    it('ativa o 2FA com o código correto e o consome', async () => {
      const { service, client, store } = makeService();
      store.set('2fa_code:u1', '123456');
      await service.enable2FA('u1', '123456');
      expect(client.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { mfaEnabled: true } });
      expect(store.has('2fa_code:u1')).toBe(false); // consumido
    });

    it('rejeita código errado e contabiliza tentativa', async () => {
      const { service, store } = makeService();
      store.set('2fa_code:u1', '123456');
      await expect(service.enable2FA('u1', '000000')).rejects.toBeInstanceOf(BadRequestException);
      expect(store.get('2fa_attempts:u1')).toBe(1);
    });

    it('rejeita quando não há código no cache', async () => {
      const { service } = makeService();
      await expect(service.enable2FA('u1', '123456')).rejects.toThrow(/expirado/);
    });
  });

  describe('refreshToken / logout', () => {
    it('rejeita refresh token na blocklist (logout)', async () => {
      const { service, store, jwt } = makeService();
      const raw = 'refresh-abc';
      const crypto = require('crypto');
      const hash = crypto.createHash('sha256').update(raw).digest('hex');
      store.set('logout_rt:' + hash, 1);
      await expect(service.refreshToken({ refreshToken: raw })).rejects.toBeInstanceOf(UnauthorizedException);
      expect(jwt.verify).not.toHaveBeenCalled();
    });

    it('logout coloca o refresh token na blocklist com TTL', async () => {
      const { service, jwt, cache } = makeService();
      jwt.decode.mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 3600 });
      await service.logout('refresh-abc');
      expect(cache.set).toHaveBeenCalledWith(expect.stringMatching(/^logout_rt:/), 1, expect.any(Number));
    });
  });

  describe('changePassword', () => {
    it('rejeita quando a senha atual está incorreta', async () => {
      const { service, client } = makeService();
      const hash = await bcrypt.hash('current', 4);
      client.user.findUnique.mockResolvedValue({ id: 'u1', password: hash, email: 'a@b.com', firstName: 'A' });
      await expect(
        service.changePassword('u1', { currentPassword: 'wrong', newPassword: 'NewPass1' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('atualiza a senha e marca passwordChangedAt (revogação de sessão)', async () => {
      const { service, client } = makeService();
      const hash = await bcrypt.hash('current1', 4);
      client.user.findUnique.mockResolvedValue({ id: 'u1', password: hash, email: 'a@b.com', firstName: 'A' });
      await service.changePassword('u1', { currentPassword: 'current1', newPassword: 'NewPass1' });
      const data = client.user.update.mock.calls[0][0].data;
      expect(data.passwordChangedAt).toBeInstanceOf(Date);
      expect(data.password).toMatch(/^\$2[aby]\$/); // hash bcrypt
    });
  });

  describe('resetPassword', () => {
    it('rejeita token que não é de reset', async () => {
      const { service, jwt } = makeService();
      jwt.verify.mockReturnValue({ type: 'other' });
      await expect(service.resetPassword({ token: 't', password: 'NewPass1' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('redefine a senha com token válido', async () => {
      const { service, client, jwt } = makeService();
      jwt.verify.mockReturnValue({ type: 'password_reset', email: 'a@b.com', userId: 'u1' });
      client.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.com', password: null, isActive: true, deletedAt: null, firstName: 'A' });
      const res = await service.resetPassword({ token: 't', password: 'NewPass1' });
      expect(res.success).toBe(true);
      expect(client.user.update.mock.calls[0][0].data.passwordChangedAt).toBeInstanceOf(Date);
    });
  });

  describe('validateGoogleUser', () => {
    it('vincula googleId a uma conta existente pelo e-mail', async () => {
      const { service, client } = makeService();
      client.user.findFirst.mockResolvedValue(null); // sem googleId
      client.user.findUnique.mockResolvedValue({ id: 'u1', avatarUrl: null }); // e-mail existe
      client.user.update.mockResolvedValue({ id: 'u1', googleId: 'g1' });
      const res: any = await service.validateGoogleUser({ googleId: 'g1', email: 'a@b.com', firstName: 'A', lastName: 'B', avatarUrl: null });
      expect(res.googleId).toBe('g1');
      expect(client.user.update.mock.calls[0][0].data.emailVerified).toBe(true);
    });

    it('cria conta só-Google (sem senha local) quando não existe', async () => {
      const { service, client } = makeService();
      client.user.findFirst.mockResolvedValue(null);
      client.user.findUnique.mockResolvedValue(null);
      client.user.create.mockImplementation(({ data }) => Promise.resolve({ id: 'u2', ...data }));
      const res: any = await service.validateGoogleUser({ googleId: 'g2', email: 'c@d.com', firstName: 'C', lastName: 'D', avatarUrl: null });
      expect(res.password).toBeNull();
      expect(res.emailVerified).toBe(true);
    });
  });
});
