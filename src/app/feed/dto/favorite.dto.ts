import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Cores selecionáveis para o avatar de um autor seguido (chaves de famílias do
 * design system). Allowlist compartilhada com o frontend — nunca aceitar hex
 * arbitrário (evita injeção de valor e mantém o tema consistente).
 */
export const FAVORITE_COLORS = [
  'principal',
  'secundaria',
  'vermelho',
  'green',
  'azul',
  'laranja',
  'violeta',
  'menta',
] as const;
export type FavoriteColor = (typeof FAVORITE_COLORS)[number];

/** Segue (favorita) um autor do Discord pelo snowflake. */
export class CreateFavoriteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  authorId!: string;

  // Última tag conhecida (exibição) — opcional; atualizada a cada follow.
  @IsOptional()
  @IsString()
  @MaxLength(120)
  authorTag?: string;
}

/**
 * Personaliza um autor (apelido + cor) — NÃO exige seguir: sem linha ainda, ela
 * é criada só com a personalização. Campos ausentes não mudam; `null` (ou apelido
 * vazio) limpa o valor.
 */
export class UpdateFavoriteDto {
  // Tag conhecida (exibição) — usada só quando a linha é criada aqui.
  @IsOptional()
  @IsString()
  @MaxLength(120)
  authorTag?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  nickname?: string | null;

  @IsOptional()
  @IsIn([...FAVORITE_COLORS])
  color?: FavoriteColor | null;
}

/** Paginação do feed de favoritos. */
export class FavoritesFeedQueryDto {
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
}
