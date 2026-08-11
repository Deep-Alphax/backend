import {
  Injectable,
  Logger,
  UnauthorizedException,
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import * as geoip from 'geoip-lite';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import {
  EmailRegisterDto,
  RefreshTokenDto,
  ResetPasswordDto,
  ChangePasswordDto,
} from './dto/auth.dto';
import { EmailService } from '../../common/services/email.service';

/**
 * Serviço de autenticação — identidade local (e-mail/senha), Google OAuth e 2FA
 * por e-mail. Segurança preservada do produto anterior:
 *   - bcrypt(12), lockout de senha por conta, rotação de refresh com segredo
 *     DERIVADO (nunca compartilha chave com o access), revogação de sessão via
 *     passwordChangedAt (sem denylist de access token), OTP em tempo constante.
 * Desacoplado do domínio antigo: sem accountType/CPF/organização.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  /** Lockout de login: nº de falhas de senha por conta antes de travar... */
  private static readonly LOGIN_MAX_FAILS = 8;
  /** ...e por quanto tempo (janela deslizante). */
  private static readonly LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000;

  // 2FA por e-mail
  private static readonly MFA_MAX_ATTEMPTS = 5;
  private static readonly MFA_CODE_TTL_MS = 10 * 60 * 1000;
  private static readonly MFA_RATE_TTL_MS = 60 * 1000;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private readonly httpService: HttpService,
    private readonly emailService: EmailService,
    private readonly usersService: UsersService,
  ) {}

  // ─────────────────────────── Credenciais ───────────────────────────

  /**
   * Valida usuário por e-mail + senha. Aplica lockout por conta (trava brute-force
   * de senha mesmo distribuído em vários IPs). Conta só falhas de SENHA (não
   * "usuário inexistente"). Retorna o usuário sem a senha, ou null.
   */
  async validateUser(email: string, password: string): Promise<any> {
    if (!email || typeof email !== 'string') return null;
    if (!password || typeof password !== 'string') return null;

    const lockId = email.toLowerCase().trim();
    const lockKey = `login_fail:${lockId}`;

    const fails = (await this.cacheManager.get<number>(lockKey)) || 0;
    if (fails >= AuthService.LOGIN_MAX_FAILS) {
      throw new HttpException(
        'Muitas tentativas de login. Tente novamente em alguns minutos.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    try {
      const user = await this.prisma.getReadClient().user.findUnique({
        where: { email: lockId },
        select: {
          id: true,
          email: true,
          password: true,
          isActive: true,
          firstName: true,
          lastName: true,
          avatarUrl: true,
          role: true,
          mfaEnabled: true,
          deletedAt: true,
        },
      });

      if (!user || !user.isActive || user.deletedAt) return null;
      if (!user.password || user.password.trim().length === 0) return null;
      if (password.trim().length === 0) return null;

      const isValid = await bcrypt.compare(password, user.password);
      if (!isValid) {
        await this.cacheManager.set(lockKey, fails + 1, AuthService.LOGIN_FAIL_WINDOW_MS);
        return null;
      }

      if (fails > 0) await this.cacheManager.del(lockKey);

      const { password: _pw, ...result } = user;
      return result;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error('[AUTH] Erro ao validar usuário:', error);
      return null;
    }
  }

  async isEmailAvailable(email: string): Promise<boolean> {
    const existing = await this.prisma.getReadClient().user.findUnique({
      where: { email: email.toLowerCase().trim() },
      select: { id: true },
    });
    return existing === null;
  }

  /** Se o usuário tem senha local (login por senha possível). */
  async hasPassword(userId: string): Promise<boolean> {
    const user = await this.prisma.getReadClient().user.findUnique({
      where: { id: userId },
      select: { password: true },
    });
    return !!(user?.password && String(user.password).trim().length > 0);
  }

  // ─────────────────────────── Cadastro ───────────────────────────

  async register(dto: EmailRegisterDto) {
    const { email, password, complete_name, acceptedTerms, acceptedPrivacyPolicy, language } = dto;

    if (!acceptedTerms || !acceptedPrivacyPolicy) {
      throw new BadRequestException('É necessário aceitar os termos e a política de privacidade');
    }

    const normalizedEmail = email.toLowerCase().trim();

    try {
      const existing = await this.prisma.getReadClient().user.findUnique({
        where: { email: normalizedEmail },
        select: { id: true },
      });
      if (existing) {
        throw new ConflictException('Já existe uma conta com este e-mail');
      }

      const hashedPassword = await bcrypt.hash(password, 12);
      const parts = complete_name.trim().split(/\s+/);
      const firstName = parts[0] || '';
      const lastName = parts.slice(1).join(' ');

      const user = await this.prisma.getWriteClient().user.create({
        data: {
          email: normalizedEmail,
          password: hashedPassword,
          firstName,
          lastName,
          language: language || 'EN',
          acceptedTerms,
          acceptedPrivacyPolicy,
        },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          avatarUrl: true,
          role: true,
          mfaEnabled: true,
        },
      });

      this.emailService
        .sendWelcomeUser({ email: user.email, firstName: user.firstName })
        .catch((err) => this.logger.warn('Falha ao enviar e-mail de boas-vindas:', err));

      return this.login(user);
    } catch (error) {
      if (error instanceof ConflictException || error instanceof BadRequestException) throw error;
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Já existe uma conta com este e-mail');
      }
      this.logger.error('Erro no cadastro:', error);
      throw new BadRequestException('Falha ao criar a conta');
    }
  }

  // ─────────────────────────── Login / tokens ───────────────────────────

  async login(user: any, opts?: { userAgent?: string }) {
    // 2FA ativo → emite challenge em vez de tokens reais.
    if (user.mfaEnabled) {
      await this.send2FACode(user.id, user.email, opts);
      const mfaToken = this.jwtService.sign(
        { sub: user.id, mfaPending: true },
        { expiresIn: '10m' },
      );
      this.logger.log(`Login com MFA iniciado — usuário ${user.id}`);
      return { mfaRequired: true, mfaToken };
    }

    return this.issueSession(user.id, user);
  }

  /** Emite access + refresh, atualiza lastLoginAt e monta o payload de resposta. */
  private async issueSession(userId: string, user: any) {
    const jwtSecret = this.configService.get<string>('JWT_SECRET');
    if (!jwtSecret) throw new UnauthorizedException('JWT secret não configurado');

    const accessToken = this.jwtService.sign({ email: user.email, sub: userId });
    const refreshToken = await this.createRefreshToken(userId);

    await this.prisma.getWriteClient().user.update({
      where: { id: userId },
      data: { lastLoginAt: new Date() },
    });

    return {
      message: 'Login successful',
      success: true,
      data: {
        access_token: accessToken,
        refresh_token: refreshToken,
        user: {
          id: userId,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          avatarUrl: user.avatarUrl,
          role: user.role,
        },
      },
    };
  }

  /** Verifica o token MFA temporário + OTP e emite tokens reais. */
  async verifyLoginMfa(mfaToken: string, code: string): Promise<any> {
    let payload: any;
    try {
      payload = this.jwtService.verify(mfaToken);
    } catch {
      throw new UnauthorizedException('Token MFA inválido ou expirado.');
    }
    if (!payload?.mfaPending || !payload?.sub) {
      throw new UnauthorizedException('Token MFA inválido.');
    }

    await this.verifyAndConsume2FACode(payload.sub, code);

    const user = await this.prisma.getWriteClient().user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, firstName: true, lastName: true, avatarUrl: true, role: true },
    });
    if (!user) throw new UnauthorizedException('Usuário não encontrado.');

    this.logger.log(`Login com MFA concluído — usuário ${user.id}`);
    return this.issueSession(user.id, user);
  }

  async resendLoginMfaCode(mfaToken: string, opts?: { userAgent?: string }) {
    let payload: any;
    try {
      payload = this.jwtService.verify(mfaToken);
    } catch {
      throw new UnauthorizedException('Token MFA inválido ou expirado.');
    }
    if (!payload?.mfaPending || !payload?.sub) {
      throw new UnauthorizedException('Token MFA inválido.');
    }
    const user = await this.prisma.getReadClient().user.findUnique({
      where: { id: payload.sub },
      select: { email: true },
    });
    if (!user) throw new UnauthorizedException('Usuário não encontrado.');

    await this.send2FACode(payload.sub, user.email, opts);
    return { message: 'Código reenviado para o seu e-mail.', success: true };
  }

  async refreshToken(dto: RefreshTokenDto) {
    try {
      const { refreshToken } = dto;

      const hash = crypto.createHash('sha256').update(refreshToken).digest('hex');
      const blocked = await this.cacheManager.get('logout_rt:' + hash);
      if (blocked) throw new UnauthorizedException('Token inválido');

      const decoded = this.jwtService.verify(refreshToken, {
        secret: this.resolveRefreshSecret(),
      });

      const user = await this.prisma.getReadClient().user.findUnique({
        where: { id: decoded.sub },
        select: { id: true, email: true, isActive: true, deletedAt: true },
      });
      if (!user || !user.isActive || user.deletedAt) {
        throw new UnauthorizedException('Usuário não encontrado ou inativo');
      }

      const accessToken = this.jwtService.sign({ email: user.email, sub: user.id });
      const newRefreshToken = await this.createRefreshToken(user.id);

      return {
        message: 'Token refreshed successfully',
        data: { access_token: accessToken, refresh_token: newRefreshToken },
      };
    } catch {
      throw new UnauthorizedException('Token de atualização inválido');
    }
  }

  async logout(refreshToken: string) {
    try {
      const decoded = this.jwtService.decode(refreshToken) as { exp?: number } | null;
      if (decoded?.exp) {
        const remainingTtlMs = decoded.exp * 1000 - Date.now();
        if (remainingTtlMs > 0) {
          const hash = crypto.createHash('sha256').update(refreshToken).digest('hex');
          await this.cacheManager.set('logout_rt:' + hash, 1, remainingTtlMs);
        }
      }
    } catch {
      // token malformado — logout ainda limpa cookies no controller
    }
    return { message: 'Logged out successfully' };
  }

  // ─────────────────────────── Reset de senha (código por e-mail) ───────────────────────────

  async forgotPassword(email: string) {
    const generic = {
      success: true,
      message: 'Se existir uma conta com este e-mail, enviaremos um código para redefinir a senha.',
    };
    const normalizedEmail = email.toLowerCase().trim();

    const user = await this.prisma.getReadClient().user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, email: true, firstName: true, isActive: true, deletedAt: true },
    });
    if (!user || !user.isActive || user.deletedAt) return generic;

    // Rate limit por conta/hora (anti-abuso), sem revelar existência.
    const hour = Math.floor(Date.now() / (60 * 60 * 1000));
    const rateKey = `forgot_pw:${normalizedEmail}:${hour}`;
    const count = (await this.cacheManager.get<number>(rateKey)) || 0;
    if (count >= 5) return generic;
    await this.cacheManager.set(rateKey, count + 1, 2 * 60 * 60 * 1000);

    try {
      await this.issuePasswordResetCode(user);
    } catch (err) {
      this.logger.error('[AUTH] Falha ao enviar código de recuperação:', err);
    }
    return generic;
  }

  async verifyResetCode(email: string, code: string) {
    const normalizedEmail = email.toLowerCase().trim();
    const cacheKey = `reset_code:${normalizedEmail}`;
    const cached = await this.cacheManager.get<any>(cacheKey);

    if (!cached) throw new BadRequestException('Código inválido ou expirado');
    if (cached.used) throw new BadRequestException('Código já foi utilizado');
    if (new Date(cached.expiresAt) < new Date()) throw new BadRequestException('Código expirado');
    if (cached.attempts >= 5) throw new BadRequestException('Muitas tentativas. Solicite um novo código');

    if (cached.code !== code) {
      cached.attempts += 1;
      await this.cacheManager.set(cacheKey, cached, 15 * 60 * 1000);
      throw new BadRequestException('Código inválido');
    }

    // Correto: marca used + attempts num único set (evita TOCTOU).
    cached.attempts += 1;
    cached.used = true;
    await this.cacheManager.set(cacheKey, cached, 15 * 60 * 1000);

    const resetToken = this.jwtService.sign(
      { email: normalizedEmail, userId: cached.userId, type: 'password_reset' },
      { expiresIn: '30m' },
    );
    return { success: true, token: resetToken, message: 'Código verificado com sucesso' };
  }

  async resendResetCode(email: string) {
    const generic = {
      success: true,
      message: 'Se o e-mail estiver cadastrado, você receberá um novo código em instantes.',
    };
    const normalizedEmail = email.toLowerCase().trim();
    const user = await this.prisma.getReadClient().user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, email: true, firstName: true, isActive: true, deletedAt: true },
    });
    if (!user || !user.isActive || user.deletedAt) return generic;

    const rateKey = `reset_resend:${normalizedEmail}`;
    if (await this.cacheManager.get(rateKey)) return generic;
    await this.cacheManager.set(rateKey, true, 60 * 1000);

    try {
      await this.issuePasswordResetCode(user);
    } catch (err) {
      this.logger.error('[AUTH] Falha ao reenviar código de recuperação:', err);
    }
    return generic;
  }

  async resetPassword(dto: ResetPasswordDto, userAgent?: string, ip?: string) {
    const { token, password } = dto;

    let decoded: { type?: string; email?: string; userId?: string };
    try {
      decoded = this.jwtService.verify(token.trim());
    } catch {
      throw new BadRequestException('Token inválido ou expirado');
    }
    if (decoded.type !== 'password_reset' || !decoded.email || !decoded.userId) {
      throw new BadRequestException('Token inválido');
    }

    const user = await this.prisma.getReadClient().user.findUnique({
      where: { email: decoded.email },
      select: { id: true, email: true, firstName: true, password: true, isActive: true, deletedAt: true },
    });
    if (!user || user.id !== decoded.userId) throw new BadRequestException('Usuário não encontrado');
    if (user.deletedAt) throw new BadRequestException('Esta conta foi excluída e não pode ser recuperada.');

    if (user.password) {
      const same = await bcrypt.compare(password, user.password);
      if (same) throw new BadRequestException('A nova senha não pode ser igual à senha atual');
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    await this.prisma.getWriteClient().user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        passwordChangedAt: new Date(), // invalida tokens emitidos antes da troca
        ...(user.isActive ? {} : { isActive: true }),
      },
    });
    await this.cacheManager.del(`reset_code:${user.email}`);

    this.notifyPasswordChanged(user.email, user.firstName, userAgent, ip);
    return { success: true, message: 'Senha redefinida com sucesso' };
  }

  private async issuePasswordResetCode(user: { id: string; email: string; firstName: string }) {
    const code = String(crypto.randomInt(100000, 1000000));
    const ttl = 15 * 60 * 1000;
    await this.cacheManager.set(
      `reset_code:${user.email.toLowerCase()}`,
      {
        code,
        userId: user.id,
        used: false,
        attempts: 0,
        expiresAt: new Date(Date.now() + ttl).toISOString(),
      },
      ttl,
    );
    await this.emailService.sendPasswordResetCode({
      email: user.email,
      firstName: user.firstName,
      code,
    });
  }

  // ─────────────────────────── Troca de senha / e-mail (logado) ───────────────────────────

  async changePassword(userId: string, dto: ChangePasswordDto, userAgent?: string, ip?: string) {
    const { currentPassword, newPassword } = dto;

    const user = await this.prisma.getReadClient().user.findUnique({
      where: { id: userId },
      select: { id: true, password: true, email: true, firstName: true },
    });
    if (!user) throw new BadRequestException('Usuário não encontrado');

    const hasLocalPassword = !!(user.password && String(user.password).trim().length > 0);
    if (hasLocalPassword) {
      if (!currentPassword || currentPassword.trim().length === 0) {
        throw new BadRequestException('Senha atual é obrigatória para trocar a senha');
      }
      const valid = await bcrypt.compare(currentPassword, user.password!);
      if (!valid) throw new UnauthorizedException('Senha atual incorreta');
      const same = await bcrypt.compare(newPassword, user.password!);
      if (same) throw new BadRequestException('A nova senha não pode ser igual à senha atual');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);
    await this.prisma.getWriteClient().user.update({
      where: { id: userId },
      data: { password: hashedPassword, passwordChangedAt: new Date() },
    });

    this.notifyPasswordChanged(user.email, user.firstName, userAgent, ip);
    return { success: true, message: 'Senha alterada com sucesso' };
  }

  async changeEmail(
    userId: string,
    dto: { newEmail: string; currentPassword: string },
    userAgent?: string,
    ip?: string,
  ) {
    const { newEmail, currentPassword } = dto;
    const user = await this.prisma.getReadClient().user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, firstName: true, password: true },
    });
    if (!user) throw new BadRequestException('Usuário não encontrado');
    if (!user.password || String(user.password).trim().length === 0) {
      throw new BadRequestException('Conta sem senha local — gerencie o e-mail pela conta Google');
    }

    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) throw new UnauthorizedException('Senha incorreta');

    const normalizedEmail = newEmail.toLowerCase().trim();
    if (normalizedEmail === user.email.toLowerCase()) {
      throw new BadRequestException('O novo e-mail deve ser diferente do atual');
    }

    const existing = await this.prisma.getReadClient().user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true },
    });
    if (existing) throw new BadRequestException('Este e-mail já está em uso');

    const code = String(crypto.randomInt(100000, 1000000));
    const ttl = 15 * 60 * 1000;
    await this.cacheManager.set(
      `email_change:${userId}`,
      {
        newEmail: normalizedEmail,
        oldEmail: user.email,
        firstName: user.firstName,
        code,
        attempts: 0,
        expiresAt: new Date(Date.now() + ttl).toISOString(),
        ip: ip ?? '',
        userAgent: userAgent ?? '',
      },
      ttl,
    );

    this.parseLocation(ip || '')
      .then((location) =>
        this.emailService.sendEmailChangeVerification({
          email: user.email,
          firstName: user.firstName,
          newEmail: normalizedEmail,
          code,
          requestDate: this.formatDateTimePtBR(new Date()),
          location,
          device: this.parseDevice(userAgent),
        }),
      )
      .catch((err) => this.logger.warn('Falha ao enviar verificação de troca de e-mail:', err));

    return { success: true, message: 'Código de verificação enviado para o seu e-mail atual.' };
  }

  async verifyEmailChange(userId: string, code: string) {
    const cacheKey = `email_change:${userId}`;
    const cached = await this.cacheManager.get<any>(cacheKey);
    if (!cached) throw new BadRequestException('Código inválido ou expirado');
    if (new Date(cached.expiresAt) < new Date()) throw new BadRequestException('Código expirado');
    if ((cached.attempts ?? 0) >= 5) {
      throw new BadRequestException('Muitas tentativas inválidas. Solicite um novo código');
    }

    cached.attempts = (cached.attempts ?? 0) + 1;
    await this.cacheManager.set(cacheKey, cached, 15 * 60 * 1000);
    if (cached.code !== code) throw new BadRequestException('Código inválido');

    try {
      await this.prisma.getWriteClient().user.update({
        where: { id: userId },
        data: { email: cached.newEmail },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new BadRequestException('Este e-mail já está em uso');
      }
      throw error;
    }
    await this.cacheManager.del(cacheKey);

    this.parseLocation(cached.ip ?? '')
      .then((location) =>
        this.emailService.sendEmailChangedNotification({
          oldEmail: cached.oldEmail,
          newEmail: cached.newEmail,
          firstName: cached.firstName,
          changedAt: this.formatDateTimePtBR(new Date()),
          location,
          device: this.parseDevice(cached.userAgent),
        }),
      )
      .catch((err) => this.logger.warn('Falha ao notificar e-mail alterado:', err));

    return { success: true, message: 'E-mail alterado com sucesso.' };
  }

  // ─────────────────────────── Google OAuth ───────────────────────────

  /** Valida ou cria usuário a partir dos dados do Google (vínculo por googleId/e-mail). */
  async validateGoogleUser(googleUser: any) {
    const prismaWrite = this.prisma.getWriteClient();
    try {
      let user = await prismaWrite.user.findFirst({ where: { googleId: googleUser.googleId } });

      if (user) {
        // e-mail pode ter mudado no Google; a foto é tratada à parte (hidratação).
        if (user.email !== googleUser.email) {
          user = await prismaWrite.user.update({
            where: { id: user.id },
            data: { email: googleUser.email, googleEmail: googleUser.email },
          });
        }
      } else {
        const existing = await prismaWrite.user.findUnique({ where: { email: googleUser.email } });
        if (existing) {
          user = await prismaWrite.user.update({
            where: { id: existing.id },
            data: {
              googleId: googleUser.googleId,
              googleEmail: googleUser.email,
              emailVerified: true,
            },
          });
        } else {
          // Conta nova só-Google: sem senha local (login tradicional indisponível
          // até definir senha via reset). e-mail já verificado pelo Google.
          user = await prismaWrite.user.create({
            data: {
              email: googleUser.email,
              password: null,
              firstName: googleUser.firstName || 'Usuário',
              lastName: googleUser.lastName || '',
              googleId: googleUser.googleId,
              googleEmail: googleUser.email,
              emailVerified: true,
              acceptedTerms: true,
              acceptedPrivacyPolicy: true,
            },
          });
        }
      }

      // Re-hospeda a foto do Google como bytes nossos (best-effort) e ajusta
      // `avatarUrl` para o nosso endpoint. Nunca derruba o login (fallback interno).
      return await this.usersService.hydrateGoogleAvatar(user, googleUser.avatarUrl);
    } catch (error) {
      this.logger.error('Erro ao validar usuário Google:', error);
      throw new BadRequestException('Falha ao autenticar com o Google');
    }
  }

  /** Troca o code do Google por tokens, obtém o perfil e faz login. */
  async validateGoogleCode(code: string, redirectUri: string): Promise<any> {
    const clientId = this.configService.get<string>('GOOGLE_CLIENT_ID');
    const clientSecret = this.configService.get<string>('GOOGLE_CLIENT_SECRET');
    if (!clientId || !clientSecret) throw new BadRequestException('Google OAuth não configurado');

    try {
      const tokenResponse = await firstValueFrom(
        this.httpService.post('https://oauth2.googleapis.com/token', {
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      );
      const { access_token } = tokenResponse.data;
      if (!access_token) throw new BadRequestException('Falha ao trocar código Google por tokens');

      const userInfo = await firstValueFrom(
        this.httpService.get('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${access_token}` },
        }),
      );
      const g = userInfo.data;
      // e-mail não verificado → account takeover (vínculo por e-mail). Rejeita.
      if (g.verified_email === false) {
        throw new UnauthorizedException('E-mail da conta Google não verificado');
      }

      const user = await this.validateGoogleUser({
        googleId: g.id,
        email: g.email,
        firstName: g.given_name || '',
        lastName: g.family_name || '',
        avatarUrl: g.picture || null,
      });
      return this.login(user);
    } catch (error: any) {
      if (error instanceof HttpException) throw error;
      this.logger.error('Erro no Google OAuth', error.response?.data);
      throw new BadRequestException('Falha na autenticação com Google');
    }
  }

  /** Código temporário (5 min) trocável por tokens — evita passar token na URL. */
  async generateAuthCode(loginResult: any): Promise<string> {
    const code = crypto.randomBytes(32).toString('hex');
    await this.cacheManager.set(`auth_code:${code}`, loginResult, 5 * 60 * 1000);
    return code;
  }

  async exchangeCodeForTokens(code: string): Promise<any> {
    if (!code || code.length !== 64 || !/^[a-f0-9]+$/i.test(code)) {
      throw new BadRequestException('Código de autorização inválido');
    }
    const cached = await this.cacheManager.get(`auth_code:${code}`);
    if (!cached) throw new BadRequestException('Código inválido ou expirado');
    await this.cacheManager.del(`auth_code:${code}`); // uso único
    return cached;
  }

  // ─────────────────────────── 2FA por e-mail ───────────────────────────

  async send2FACode(
    userId: string,
    userEmail: string,
    opts?: { userAgent?: string; purpose?: 'auth' | 'delete' },
  ): Promise<void> {
    const rateLimitKey = `2fa_rate:${userId}`;
    if (await this.cacheManager.get(rateLimitKey)) {
      throw new BadRequestException('Aguarde 1 minuto antes de solicitar um novo código.');
    }

    const code = String(crypto.randomInt(100000, 1000000));
    const cacheKey = `2fa_code:${userId}`;
    const attemptsKey = `2fa_attempts:${userId}`;

    const loginDate = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .format(new Date())
      .replace(',', ' às');
    const loginDevice = this.parseDevice(opts?.userAgent);

    await this.cacheManager.set(cacheKey, code, AuthService.MFA_CODE_TTL_MS);
    await this.cacheManager.del(attemptsKey);

    try {
      if (opts?.purpose === 'delete') {
        await this.emailService.sendAccountDeletionCode(userEmail, code);
      } else {
        await this.emailService.send2FACode(userEmail, code, { loginDate, loginDevice });
      }
    } catch (emailError) {
      await this.cacheManager.del(cacheKey);
      this.logger.error(`Falha ao enviar código 2FA — usuário ${userId}:`, emailError);
      throw new BadRequestException('Falha ao enviar o e-mail. Tente novamente.');
    }

    await this.cacheManager.set(rateLimitKey, true, AuthService.MFA_RATE_TTL_MS);
  }

  async enable2FA(userId: string, code: string): Promise<void> {
    await this.verifyAndConsume2FACode(userId, code);
    await this.prisma.getWriteClient().user.update({
      where: { id: userId },
      data: { mfaEnabled: true },
    });
  }

  async disable2FA(userId: string, code: string): Promise<void> {
    await this.verifyAndConsume2FACode(userId, code);
    await this.prisma.getWriteClient().user.update({
      where: { id: userId },
      data: { mfaEnabled: false },
    });
  }

  /**
   * Exclui a PRÓPRIA conta — soft-delete + anonimização (exige OTP por e-mail).
   * Marca deletedAt + isActive=false + passwordChangedAt=now (bloqueia login e
   * invalida tokens), neutraliza credenciais e anonimiza a PII. Idempotente.
   */
  async deleteOwnAccount(userId: string, code: string, reason?: string): Promise<void> {
    await this.verifyAndConsume2FACode(userId, code);

    const user = await this.prisma.getWriteClient().user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('Usuário não encontrado.');
    if (user.deletedAt) return; // idempotente

    const now = new Date();
    const deletedInfo = {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      createdAt: user.createdAt,
    };
    const anonEmail = `deleted-${user.id}@deleted.deepalpha.local`;

    await this.prisma.getWriteClient().user.update({
      where: { id: userId },
      data: {
        email: anonEmail,
        firstName: 'Conta',
        lastName: 'excluída',
        avatarUrl: null,
        googleId: null,
        googleEmail: null,
        mfaEnabled: false,
        // Senha inutilizável (não é hash bcrypt válido → compare sempre falha).
        password: crypto.randomBytes(48).toString('hex'),
        isActive: false,
        deletedAt: now,
        passwordChangedAt: now,
      },
    });
    await this.cacheManager.del(`2fa_rate:${userId}`);
    this.logger.log(`Conta excluída (soft-delete/anonimização) — usuário ${userId}`);

    try {
      await this.emailService.sendAccountDeletionNotice({
        reason: reason?.trim() || 'Não informado',
        account: { ...deletedInfo, deletedAt: now },
      });
    } catch (err) {
      this.logger.error(`Falha ao enviar aviso de exclusão (usuário ${userId}): ${(err as Error)?.message}`);
    }
  }

  /** Verifica o OTP em tempo constante e o consome. Limita a 5 tentativas. */
  private async verifyAndConsume2FACode(userId: string, code: string): Promise<void> {
    const cacheKey = `2fa_code:${userId}`;
    const attemptsKey = `2fa_attempts:${userId}`;

    const stored = await this.cacheManager.get<string>(cacheKey);
    if (!stored) throw new BadRequestException('Código incorreto ou expirado.');

    const attempts = (await this.cacheManager.get<number>(attemptsKey)) || 0;
    if (attempts >= AuthService.MFA_MAX_ATTEMPTS) {
      await this.cacheManager.del(cacheKey);
      throw new BadRequestException('Muitas tentativas incorretas. Solicite um novo código.');
    }

    const isValid =
      stored.length === code.length &&
      crypto.timingSafeEqual(Buffer.from(stored, 'utf8'), Buffer.from(code, 'utf8'));

    if (!isValid) {
      const next = attempts + 1;
      await this.cacheManager.set(attemptsKey, next, AuthService.MFA_CODE_TTL_MS);
      if (next >= AuthService.MFA_MAX_ATTEMPTS) await this.cacheManager.del(cacheKey);
      throw new BadRequestException('Código incorreto ou expirado.');
    }

    await this.cacheManager.del(cacheKey);
    await this.cacheManager.del(attemptsKey);
  }

  // ─────────────────────────── Refresh secret / helpers ───────────────────────────

  /**
   * Segredo do REFRESH token: usa JWT_REFRESH_SECRET, senão DERIVA de JWT_SECRET
   * com sufixo dedicado — garante que access e refresh NUNCA compartilhem chave.
   */
  private resolveRefreshSecret(): string | undefined {
    const explicit = this.configService.get<string>('JWT_REFRESH_SECRET');
    if (explicit) return explicit;
    const base = this.configService.get<string>('JWT_SECRET');
    return base ? `${base}:refresh` : undefined;
  }

  private async createRefreshToken(userId: string): Promise<string> {
    const refreshSecret = this.resolveRefreshSecret();
    if (!refreshSecret) throw new UnauthorizedException('JWT secret não configurado');
    const expiresIn = this.configService.get<string>('JWT_REFRESH_EXPIRES_IN') || '7d';
    return this.jwtService.sign({ sub: userId }, { secret: refreshSecret, expiresIn } as any);
  }

  private notifyPasswordChanged(email: string, firstName: string, userAgent?: string, ip?: string) {
    const changedAt = this.formatDateTimePtBR(new Date());
    const device = this.parseDevice(userAgent);
    this.parseLocation(ip ?? '')
      .then((location) =>
        this.emailService.sendPasswordChangedNotification({ email, firstName, changedAt, location, device }),
      )
      .catch((err) => this.logger.warn('Falha ao enviar e-mail de senha alterada:', err));
  }

  private formatDateTimePtBR(date: Date): string {
    const tz = 'America/Sao_Paulo';
    const d = date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric', timeZone: tz });
    const t = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: tz });
    return `${d} às ${t}`;
  }

  private async parseLocation(ip: string): Promise<string> {
    if (!ip || ip === '—') return '—';
    const cleanIp = ip.replace(/^::ffff:/, '');
    try {
      const token = this.configService.get<string>('IPINFO_TOKEN');
      if (token) {
        const resp = await firstValueFrom(
          this.httpService.get(`https://ipinfo.io/${cleanIp}/json?token=${token}`, { timeout: 3000 } as any),
        );
        const d = resp.data;
        if (d && !d.bogon) {
          if (d.city && d.region) return `${d.city}, ${d.region}`;
          if (d.city) return d.city;
          if (d.country) return d.country;
        }
      }
    } catch {
      /* fallback p/ geoip */
    }
    try {
      const geo = geoip.lookup(cleanIp);
      if (geo) {
        if (geo.city && geo.region) return `${geo.city}, ${geo.region}`;
        if (geo.city) return geo.city;
        if (geo.country) return geo.country;
      }
    } catch {
      /* ignore */
    }
    return '—';
  }

  private parseDevice(userAgent?: string): string {
    if (!userAgent) return 'Dispositivo desconhecido';
    const ua = userAgent;
    let browser = 'Navegador';
    if (ua.includes('Edg/')) browser = 'Edge';
    else if (ua.includes('Chrome/')) browser = 'Chrome';
    else if (ua.includes('Firefox/')) browser = 'Firefox';
    else if (ua.includes('Safari/') && !ua.includes('Chrome')) browser = 'Safari';
    let os = '';
    if (ua.includes('Windows')) os = 'Windows';
    else if (ua.includes('Mac OS X')) os = 'macOS';
    else if (ua.includes('Android')) os = 'Android';
    else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';
    else if (ua.includes('Linux')) os = 'Linux';
    return os ? `${browser} no ${os}` : browser;
  }
}
