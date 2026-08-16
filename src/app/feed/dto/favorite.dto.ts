import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

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
