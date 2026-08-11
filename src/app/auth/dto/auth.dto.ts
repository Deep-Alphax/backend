import {
  IsEmail,
  IsString,
  IsOptional,
  MinLength,
  MaxLength,
  IsNotEmpty,
  IsBoolean,
  IsEnum,
  Matches,
  Length,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// Idiomas suportados na UI. String simples (não é enum do Prisma) para manter o
// domínio de auth desacoplado do schema — o default de persistência é 'EN'.
export enum Language {
  EN = 'EN',
  PT = 'PT',
  ES = 'ES',
}

/**
 * Regra única de senha do projeto: mínimo 8, com maiúscula, minúscula e dígito.
 * Reutilizada no register/reset/change para não haver drift entre os fluxos.
 */
export const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;
const PASSWORD_MESSAGE =
  'A senha deve ter no mínimo 8 caracteres, com ao menos uma maiúscula, uma minúscula e um número';

export class EmailLoginDto {
  @ApiProperty({ description: 'E-mail da conta', example: 'user@example.com' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ description: 'Senha', minLength: 8 })
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  password: string;

  @ApiPropertyOptional({ description: 'Token Cloudflare Turnstile (anti-bot).' })
  @IsOptional()
  @IsString()
  turnstileToken?: string;
}

export class EmailRegisterDto {
  @ApiProperty({ description: 'E-mail da conta' })
  @IsEmail()
  email: string;

  @ApiProperty({ description: 'Senha', minLength: 8 })
  @IsString()
  @Matches(PASSWORD_REGEX, { message: PASSWORD_MESSAGE })
  password: string;

  @ApiProperty({ description: 'Nome completo (nome e sobrenome)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  complete_name: string;

  @ApiProperty({ description: 'Aceite dos termos de uso' })
  @IsBoolean()
  acceptedTerms: boolean;

  @ApiProperty({ description: 'Aceite da política de privacidade' })
  @IsBoolean()
  acceptedPrivacyPolicy: boolean;

  @ApiPropertyOptional({ description: 'Idioma preferido', enum: Language, default: Language.EN })
  @IsOptional()
  @IsEnum(Language)
  language?: Language;

  // Verificado pelo TurnstileGuard; declarado para não ser barrado pelo
  // forbidNonWhitelisted do ValidationPipe.
  @ApiPropertyOptional({ description: 'Token Cloudflare Turnstile (anti-bot).' })
  @IsOptional()
  @IsString()
  turnstileToken?: string;
}

export class RefreshTokenDto {
  @ApiProperty({ description: 'Refresh token' })
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ description: 'E-mail da conta' })
  @IsEmail()
  @IsNotEmpty()
  email: string;
}

export class VerifyResetCodeDto {
  @ApiProperty({ description: 'E-mail da conta' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ description: 'Código de 6 dígitos' })
  @IsString()
  @IsNotEmpty()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'O código deve conter exatamente 6 dígitos' })
  code: string;
}

export class ResendResetCodeDto {
  @ApiProperty({ description: 'E-mail da conta' })
  @IsEmail()
  @IsNotEmpty()
  email: string;
}

export class ResetPasswordDto {
  @ApiProperty({ description: 'Token retornado por verify-reset-code' })
  @IsString()
  @IsNotEmpty()
  token: string;

  @ApiProperty({ description: 'Nova senha', minLength: 8 })
  @IsString()
  @Matches(PASSWORD_REGEX, { message: PASSWORD_MESSAGE })
  password: string;
}

export class ChangePasswordDto {
  @ApiPropertyOptional({
    description:
      'Senha atual. Obrigatória se a conta já tiver senha; omitir para contas só-Google.',
  })
  @IsOptional()
  @IsString()
  currentPassword?: string;

  @ApiProperty({ description: 'Nova senha', minLength: 8 })
  @IsString()
  @Matches(PASSWORD_REGEX, { message: PASSWORD_MESSAGE })
  newPassword: string;
}

export class ChangeEmailDto {
  @ApiProperty({ description: 'Novo e-mail' })
  @IsEmail()
  @IsNotEmpty()
  newEmail: string;

  @ApiProperty({ description: 'Senha atual (confirmação de segurança)' })
  @IsString()
  @IsNotEmpty()
  currentPassword: string;
}

export class VerifyEmailChangeDto {
  @ApiProperty({ description: 'Código de 6 dígitos enviado ao e-mail atual' })
  @IsString()
  @IsNotEmpty()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'O código deve conter exatamente 6 dígitos' })
  code: string;
}

export class TwoFactorCodeDto {
  @ApiProperty({ description: 'Código de 6 dígitos para ativar/desativar o 2FA', example: '482931' })
  @IsString()
  @IsNotEmpty()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'O código deve conter exatamente 6 dígitos' })
  code: string;
}

export class VerifyLoginMfaDto {
  @ApiProperty({ description: 'Token MFA temporário (mfaRequired=true no login)' })
  @IsString()
  @IsNotEmpty()
  mfaToken: string;

  @ApiProperty({ description: 'Código de 6 dígitos enviado por e-mail', example: '482931' })
  @IsString()
  @IsNotEmpty()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'O código deve conter exatamente 6 dígitos' })
  code: string;
}

export class DeleteAccountDto {
  @ApiProperty({ description: 'Código de 6 dígitos para confirmar a exclusão', example: '482931' })
  @IsString()
  @IsNotEmpty()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'O código deve conter exatamente 6 dígitos' })
  code: string;

  @ApiProperty({ description: 'Motivo da exclusão (LGPD)', example: 'Não uso mais a plataforma' })
  @IsString()
  @IsNotEmpty({ message: 'Informe o motivo da exclusão.' })
  @MaxLength(500)
  reason: string;
}
