import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PartialType } from '@nestjs/swagger';
import { MentorshipAccent } from '@prisma/client';

/*
 * DTOs da mentoria.
 *
 * O ValidationPipe global roda com `whitelist` + `forbidNonWhitelisted`: campo
 * não declarado aqui é REJEITADO, não ignorado. Convenção dos PATCH: campo
 * ausente não muda nada (nenhum campo é anulável — todos têm default no banco).
 */

/** Teto de itens numa reordenação — evita payload absurdo numa transação. */
const MAX_REORDER = 500;

/**
 * URL de capa/vídeo aceita só http(s) ou caminho absoluto do próprio app
 * (`/mentorship/...`). Bloqueia `javascript:` e `data:` — a string vai direto
 * para `src`/`href` no front, então o esquema é superfície de XSS.
 */
const SAFE_URL = /^(https?:\/\/|\/)[^\s]*$/;
const URL_MESSAGE = 'deve ser uma URL http(s) ou um caminho começando com "/"';

/** Slug de URL: minúsculas, dígitos e hífen. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Duração máxima de uma aula: 12h em segundos. Peneira erro de digitação. */
const MAX_DURATION_SEC = 43_200;

export class CreateModuleDto {
  @IsString()
  @MaxLength(80)
  @Matches(SLUG, { message: 'slug deve conter só minúsculas, dígitos e hífen' })
  slug: string;

  @IsString()
  @MaxLength(120)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  subtitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Matches(SAFE_URL, { message: `coverUrl ${URL_MESSAGE}` })
  coverUrl?: string;

  @IsOptional()
  @IsEnum(MentorshipAccent)
  accent?: MentorshipAccent;

  @IsOptional()
  @IsBoolean()
  published?: boolean;
}

/**
 * Mesmos campos do create, todos opcionais (`slug` incluído — renomear é
 * permitido). `PartialType` reaproveita os decorators: reescrevê-los à mão
 * deixaria os dois DTOs livres para divergirem.
 */
export class UpdateModuleDto extends PartialType(CreateModuleDto) {}

export class CreateLessonDto {
  @IsString()
  @MaxLength(160)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(999)
  episode?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_DURATION_SEC)
  durationSec?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Matches(SAFE_URL, { message: `coverUrl ${URL_MESSAGE}` })
  coverUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Matches(SAFE_URL, { message: `videoUrl ${URL_MESSAGE}` })
  videoUrl?: string;

  @IsOptional()
  @IsBoolean()
  published?: boolean;
}

/**
 * Mesmos campos do create, todos opcionais. `PartialType` reaproveita os
 * decorators de validação — reescrevê-los à mão abriria espaço para os dois
 * DTOs divergirem (um limite atualizado só no create, por exemplo).
 */
export class UpdateLessonDto extends PartialType(CreateLessonDto) {}

/** Nova ordem: a posição de cada id passa a ser o índice na lista. */
export class ReorderDto {
  @IsArray()
  @ArrayMaxSize(MAX_REORDER)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  ids: string[];
}

/**
 * Progresso reportado pelo player.
 *
 * `positionSec` é conferido contra a duração real da aula NO SERVIDOR — o
 * cliente não é autoridade sobre quanto assistiu.
 */
export class ProgressDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_DURATION_SEC)
  positionSec?: number;

  @IsOptional()
  @IsBoolean()
  completed?: boolean;
}
