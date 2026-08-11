import {
  IsEnum,
  IsOptional,
  IsString,
  IsBoolean,
  IsInt,
  Min,
  Max,
  MaxLength,
  IsNotEmpty,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Chain } from '@prisma/client';

/** Janela de atribuição: limites de sanidade (1h a 7 dias). */
const MIN_WINDOW_HOURS = 1;
const MAX_WINDOW_HOURS = 168;

export class CreateSourceDto {
  @ApiProperty({ description: 'Nome da fonte (ex.: "Obsidian Desk")' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name: string;

  @ApiPropertyOptional({
    description:
      'Janela de atribuição em horas (compra do usuário após a da fonte)',
    default: 6,
    minimum: MIN_WINDOW_HOURS,
    maximum: MAX_WINDOW_HOURS,
  })
  @IsOptional()
  @IsInt()
  @Min(MIN_WINDOW_HOURS)
  @Max(MAX_WINDOW_HOURS)
  attributionWindowHours?: number;
}

export class UpdateSourceDto {
  @ApiPropertyOptional({ description: 'Novo nome' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  name?: string;

  @ApiPropertyOptional({
    description: 'Ativa/desativa a fonte (inativa não atribui)',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    description: 'Janela de atribuição em horas',
    minimum: MIN_WINDOW_HOURS,
    maximum: MAX_WINDOW_HOURS,
  })
  @IsOptional()
  @IsInt()
  @Min(MIN_WINDOW_HOURS)
  @Max(MAX_WINDOW_HOURS)
  attributionWindowHours?: number;
}

export class AddSourceWalletDto {
  @ApiProperty({ enum: Chain, description: 'Blockchain da carteira da fonte' })
  @IsEnum(Chain)
  chain: Chain;

  @ApiProperty({
    description: 'Endereço da carteira da fonte (0x… EVM; base58 Solana)',
    example: '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  address: string;

  @ApiPropertyOptional({ description: 'Rótulo opcional da carteira da fonte' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  label?: string;
}
