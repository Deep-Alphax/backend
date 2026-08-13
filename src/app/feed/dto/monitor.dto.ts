import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';

/** Cria uma regra de monitoramento de canal do Discord. */
export class CreateMonitorDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  // Alvo: channelId (canal) OU guildId (servidor inteiro). Ao menos um (validado no service).
  @IsOptional()
  @IsString()
  @MaxLength(64)
  channelId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  guildId?: string;

  // Regex "/corpo/flags" OU substring. VAZIO/ausente = espelha tudo.
  @IsOptional()
  @IsString()
  @MaxLength(500)
  pattern?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  telegramChatId!: string;

  @IsOptional()
  @IsBoolean()
  waitForBotReply?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Atualiza uma regra (todos os campos opcionais). */
export class UpdateMonitorDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  channelId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  guildId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  pattern?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  telegramChatId?: string;

  @IsOptional()
  @IsBoolean()
  waitForBotReply?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Query de listagem do feed de capturas (paginada + filtros). */
export class FeedQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  channelId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  monitorId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}
