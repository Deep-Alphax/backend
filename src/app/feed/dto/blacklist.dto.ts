import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/** Adiciona um usuário à blacklist (ao menos um de discordUserId/username). */
export class CreateBlacklistDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  discordUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  username?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateBlacklistDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  discordUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  username?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
