import {
  Controller,
  Post,
  Patch,
  Body,
  UseGuards,
  Get,
  Query,
  HttpCode,
  HttpStatus,
  Res,
  BadRequestException,
  UnauthorizedException,
  Request,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
  ApiQuery,
} from '@nestjs/swagger';
import { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { LocalAuthGuard } from './guards/local-auth.guard';
import { GoogleAuthGuard } from './guards/google-auth.guard';
import { TurnstileGuard } from './guards/turnstile.guard';
import { OAuthStateService } from './oauth-state.service';
import {
  EmailRegisterDto,
  RefreshTokenDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  ChangePasswordDto,
  ChangeEmailDto,
  VerifyResetCodeDto,
  ResendResetCodeDto,
  VerifyEmailChangeDto,
  TwoFactorCodeDto,
  DeleteAccountDto,
  VerifyLoginMfaDto,
} from './dto/auth.dto';
import { sanitizeRelativePath } from '../../common/utils/safe-redirect.util';
import { NoCache } from '../../common/decorators/cache.decorator';
import {
  applyAuthCookiesFromResult,
  clearAuthCookies,
  resolveAuthSurface,
  refreshCookieName,
} from './auth-cookies.util';

/** Extrai o IP real do cliente (1º IP do XFF, resolvido pelo trust proxy). */
function clientIp(req: any): string {
  return req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
}

/** Normaliza uma URI p/ comparação exata: trim + sem barra(s) final(is). */
function normalizeUri(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

@ApiTags('Authentication')
@Controller('api/v1/auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly oauthState: OAuthStateService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Callback OAuth esperado do backend — ÚNICO `redirectUri` válido na troca do
   * code. Resolve igual à `GoogleStrategy` (env `GOOGLE_CALLBACK_URL`, senão o
   * default local) para as duas pontas casarem sempre.
   */
  private expectedGoogleRedirectUri(): string {
    const configured = this.configService.get<string>('GOOGLE_CALLBACK_URL');
    const port = this.configService.get<string>('PORT') || '3333';
    return normalizeUri(
      configured || `http://localhost:${port}/api/v1/auth/google/callback`,
    );
  }

  @Get('email/availability')
  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Verifica se um e-mail já está cadastrado' })
  @ApiQuery({ name: 'email', required: true })
  @ApiResponse({ status: 200, description: '{ available: boolean }' })
  async checkEmailAvailability(@Query('email') email: string) {
    if (!email || !email.includes('@')) {
      throw new BadRequestException('Endereço de e-mail inválido');
    }
    const available = await this.authService.isEmailAvailable(email);
    return { available };
  }

  @Post('register')
  @UseGuards(TurnstileGuard)
  @Throttle({ short: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Cadastro de novo usuário (autologa)' })
  @ApiBody({ type: EmailRegisterDto })
  @ApiResponse({ status: 201, description: 'Conta criada e sessão iniciada' })
  @ApiResponse({ status: 409, description: 'E-mail já cadastrado' })
  async register(
    @Body() registerDto: EmailRegisterDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.register(registerDto);
    return applyAuthCookiesFromResult(res, 'client', result);
  }

  @Post('login')
  @UseGuards(TurnstileGuard, LocalAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login com e-mail e senha' })
  @ApiResponse({ status: 200, description: 'Login efetuado (ou desafio MFA)' })
  @ApiResponse({ status: 401, description: 'Credenciais inválidas' })
  async loginEmail(@Request() req, @Res({ passthrough: true }) res: Response) {
    const result = await this.authService.login(req.user, {
      userAgent: req.headers?.['user-agent'],
    });
    return applyAuthCookiesFromResult(res, 'client', result);
  }

  @Post('login/admin')
  @UseGuards(TurnstileGuard, LocalAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Admin] Login — Turnstile + role-gated' })
  @ApiResponse({ status: 200, description: 'Login efetuado' })
  @ApiResponse({ status: 401, description: 'Credenciais inválidas' })
  async loginAdmin(@Request() req, @Res({ passthrough: true }) res: Response) {
    // 401 (não 403): um 403 confirmaria que a senha está CERTA (só falta papel),
    // formando um oráculo para validar credenciais roubadas. Indistinguível.
    if (req.user?.role !== 'ADMIN') {
      throw new UnauthorizedException('Invalid credentials');
    }
    const result = await this.authService.login(req.user, {
      userAgent: req.headers?.['user-agent'],
    });
    return applyAuthCookiesFromResult(res, 'admin', result);
  }

  @Get('google')
  @UseGuards(GoogleAuthGuard)
  @ApiOperation({ summary: 'Inicia o login com Google (redireciona ao consent)' })
  @ApiQuery({ name: 'redirect_to', required: false, description: 'Caminho relativo pós-login' })
  @ApiResponse({ status: 302, description: 'Redireciona para o consent do Google' })
  async googleAuth() {
    // GoogleAuthGuard monta a URL de consent + state (redirect_to saneado).
  }

  @Get('google/callback')
  @NoCache()
  @ApiOperation({ summary: 'Callback do Google (mediado pelo backend)' })
  @ApiQuery({ name: 'code', required: false })
  @ApiQuery({ name: 'state', required: false })
  @ApiQuery({ name: 'error', required: false })
  @ApiResponse({ status: 302, description: 'Redireciona para o callback do frontend' })
  async googleCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ) {
    const frontendUrl = this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000';
    const { redirectTo } = this.oauthState.verify(state);
    const url = new URL('/auth/callback', frontendUrl);

    if (error) url.searchParams.set('error', error);
    else if (code) url.searchParams.set('code', code);
    else url.searchParams.set('error', 'google_oauth_failed');

    const safe = sanitizeRelativePath(redirectTo);
    if (safe) url.searchParams.set('redirect_to', safe);

    return res.redirect(url.toString());
  }

  @Post('google/validate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Troca o code do Google por tokens de sessão' })
  @ApiResponse({ status: 200, description: 'Login efetuado' })
  @ApiResponse({ status: 400, description: 'Code inválido ou expirado' })
  async validateGoogleCode(
    @Request() req,
    @Body() body: { code: string; redirectUri: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!body.code) throw new BadRequestException('Código de autorização do Google é obrigatório');
    if (!body.redirectUri) throw new BadRequestException('URI de redirecionamento é obrigatória');

    // O `redirectUri` NÃO é um destino de redirect do browser: é o `redirect_uri`
    // repassado ao token endpoint do Google, que exige valor IDÊNTICO ao usado no
    // consent — ou seja, o callback do BACKEND (host `api.*`, não o do front).
    // Por isso o valor legítimo é ÚNICO e conhecido: comparamos exatamente com o
    // callback resolvido (mesma lógica da GoogleStrategy). Isso trava qualquer
    // open-redirect e corrige o falso "não permitido" em prod (a checagem antiga
    // usava as origens do FRONT, onde `api.deepalpha.fun` nunca aparece).
    if (normalizeUri(body.redirectUri) !== this.expectedGoogleRedirectUri()) {
      throw new BadRequestException('redirectUri não permitido');
    }

    const result = await this.authService.validateGoogleCode(body.code, body.redirectUri);
    return applyAuthCookiesFromResult(res, resolveAuthSurface(req), result);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Renova o access token' })
  @ApiResponse({ status: 200, description: 'Token renovado' })
  @ApiResponse({ status: 401, description: 'Refresh token inválido' })
  async refreshToken(
    @Request() req,
    @Res({ passthrough: true }) res: Response,
    @Body() body: { refresh_token?: string; refreshToken?: string },
  ) {
    const surface = resolveAuthSurface(req);
    const token =
      req.cookies?.[refreshCookieName(surface)] || body?.refresh_token || body?.refreshToken;
    if (!token) throw new UnauthorizedException('Refresh token ausente');

    const dto: RefreshTokenDto = { refreshToken: token };
    const result = await this.authService.refreshToken(dto);
    return applyAuthCookiesFromResult(res, surface, result);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Logout (só da superfície atual)' })
  @ApiBearerAuth()
  async logout(@Request() req, @Res({ passthrough: true }) res: Response) {
    const surface = resolveAuthSurface(req);
    const refreshToken =
      req.cookies?.[refreshCookieName(surface)] || req.headers['x-refresh-token'];
    if (refreshToken) await this.authService.logout(refreshToken);
    clearAuthCookies(res, surface);
    return { message: 'Logged out successfully' };
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle({ long: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Solicita redefinição de senha (código por e-mail)' })
  @ApiResponse({ status: 200, description: 'Pedido aceito (resposta genérica)' })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto.email);
  }

  @Post('verify-reset-code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verifica o código e retorna o token de redefinição' })
  @ApiResponse({ status: 200, description: 'Código verificado, token retornado' })
  @ApiResponse({ status: 400, description: 'Código inválido ou expirado' })
  async verifyResetCode(@Body() dto: VerifyResetCodeDto) {
    return this.authService.verifyResetCode(dto.email, dto.code);
  }

  @Post('resend-reset-code')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle({ long: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Reenvia o código de redefinição (1/min por conta)' })
  @ApiResponse({ status: 200, description: 'Pedido aceito' })
  async resendResetCode(@Body() dto: ResendResetCodeDto) {
    return this.authService.resendResetCode(dto.email);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Redefine a senha com o token de verify-reset-code' })
  @ApiResponse({ status: 200, description: 'Senha redefinida' })
  @ApiResponse({ status: 400, description: 'Token ou senha inválidos' })
  async resetPassword(@Request() req, @Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto, req.headers?.['user-agent'], clientIp(req));
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Troca a senha do usuário logado' })
  @ApiBody({ type: ChangePasswordDto })
  @ApiResponse({ status: 200, description: 'Senha alterada' })
  @ApiResponse({ status: 401, description: 'Não autenticado ou senha atual incorreta' })
  async changePassword(@Request() req, @Body() dto: ChangePasswordDto) {
    return this.authService.changePassword(req.user.id, dto, req.headers?.['user-agent'], clientIp(req));
  }

  @Patch('change-email')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Altera o e-mail da conta (requer senha atual)' })
  @ApiBody({ type: ChangeEmailDto })
  @ApiResponse({ status: 200, description: 'Código de verificação enviado' })
  async changeEmail(@Request() req, @Body() dto: ChangeEmailDto) {
    return this.authService.changeEmail(req.user.id, dto, req.headers?.['user-agent'], clientIp(req));
  }

  @Post('verify-email-change')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Confirma a troca de e-mail com o código' })
  @ApiBody({ type: VerifyEmailChangeDto })
  @ApiResponse({ status: 200, description: 'E-mail alterado' })
  async verifyEmailChange(@Request() req, @Body() dto: VerifyEmailChangeDto) {
    return this.authService.verifyEmailChange(req.user.id, dto.code);
  }

  @Get('profile')
  @NoCache()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Perfil do usuário autenticado' })
  @ApiResponse({ status: 200, description: 'Perfil' })
  async getProfile(@Request() req) {
    const hasPassword = await this.authService.hasPassword(req.user.id);
    return { data: { ...req.user, hasPassword }, message: 'User profile', success: true };
  }

  // ──────────────── 2FA por e-mail ────────────────

  @Post('2fa/send-code')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Envia OTP por e-mail para ativar/desativar o 2FA' })
  @ApiResponse({ status: 200, description: 'Código enviado' })
  async send2FACode(@Request() req) {
    await this.authService.send2FACode(req.user.id, req.user.email, {
      userAgent: req.headers?.['user-agent'],
    });
    return { message: 'Código enviado para o seu e-mail.', success: true };
  }

  @Post('2fa/enable')
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Ativa o 2FA após verificar o OTP' })
  @ApiBody({ type: TwoFactorCodeDto })
  @ApiResponse({ status: 200, description: '2FA ativado' })
  async enable2FA(@Request() req, @Body() dto: TwoFactorCodeDto) {
    await this.authService.enable2FA(req.user.id, dto.code);
    return { message: '2FA ativado com sucesso.', success: true };
  }

  @Post('2fa/disable')
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Desativa o 2FA após verificar o OTP' })
  @ApiBody({ type: TwoFactorCodeDto })
  @ApiResponse({ status: 200, description: '2FA desativado' })
  async disable2FA(@Request() req, @Body() dto: TwoFactorCodeDto) {
    await this.authService.disable2FA(req.user.id, dto.code);
    return { message: '2FA desativado com sucesso.', success: true };
  }

  @Post('2fa/verify-login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verifica o MFA de login e emite tokens reais' })
  @ApiBody({ type: VerifyLoginMfaDto })
  @ApiResponse({ status: 200, description: 'Login MFA concluído' })
  @ApiResponse({ status: 401, description: 'Token MFA inválido ou expirado' })
  async verifyLoginMfa(
    @Request() req,
    @Body() dto: VerifyLoginMfaDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.verifyLoginMfa(dto.mfaToken, dto.code);
    return applyAuthCookiesFromResult(res, resolveAuthSurface(req), result);
  }

  @Post('2fa/resend-login-code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reenvia o código MFA durante o login' })
  @ApiResponse({ status: 200, description: 'Código reenviado' })
  async resendLoginMfaCode(@Body() dto: { mfaToken: string }, @Request() req) {
    return this.authService.resendLoginMfaCode(dto.mfaToken, {
      userAgent: req.headers?.['user-agent'],
    });
  }

  // ──────────────── Exclusão de conta ────────────────

  @Post('account/delete/send-code')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Envia OTP por e-mail para confirmar a exclusão da conta' })
  @ApiResponse({ status: 200, description: 'Código enviado' })
  async sendAccountDeletionCode(@Request() req) {
    await this.authService.send2FACode(req.user.id, req.user.email, { purpose: 'delete' });
    return { message: 'Código enviado para o seu e-mail.', success: true };
  }

  @Post('account/delete')
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ short: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Exclui (soft-delete/anonimiza) a conta do usuário' })
  @ApiBody({ type: DeleteAccountDto })
  @ApiResponse({ status: 200, description: 'Conta excluída' })
  async deleteAccount(
    @Request() req,
    @Body() dto: DeleteAccountDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.authService.deleteOwnAccount(req.user.id, dto.code, dto.reason);
    clearAuthCookies(res, resolveAuthSurface(req));
    return { message: 'Conta excluída com sucesso.', success: true };
  }
}
