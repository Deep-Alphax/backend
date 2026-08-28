import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsIn,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/*
 * DTOs do KOL Index (preset global + override por conta).
 *
 * Convenção dos PATCH: campo AUSENTE = não mexe; campo `null` = volta a herdar
 * do preset. O ValidationPipe global roda com `whitelist` + `forbidNonWhitelisted`,
 * então tudo que não estiver declarado aqui é rejeitado.
 */

/** Teto de itens por lista — evita payload que estoure a linha do Postgres. */
const MAX_WALLETS = 200;
const MAX_TAGS = 40;

/**
 * Avatar é uma data URL de imagem RASTER, nunca `svg+xml`: um SVG carrega
 * script e um dia pode ser aberto fora de um `<img>`. Teto de ~300KB binários.
 */
const AVATAR_DATA_URL = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
const AVATAR_MAX = 400_000;

export class WalletRefDto {
  @IsString()
  @MaxLength(120)
  name: string;

  @IsString()
  @MaxLength(120)
  address: string;
}

/** Campos que descrevem um KOL — compartilhados pelo preset e pelo override. */
class KolFieldsDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  relevance?: number | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_TAGS)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  types?: string[] | null;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  twitter?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string | null;

  @IsOptional()
  @MaxLength(AVATAR_MAX)
  @Matches(AVATAR_DATA_URL, {
    message: 'avatar deve ser uma data URL de imagem (png, jpeg, webp ou gif)',
  })
  avatar?: string | null;
}

// ── Preset (ADMIN) ───────────────────────────────────────────────────────────

/** Cria um KOL no preset global. O `id` é gerado pelo backend. */
export class CreateKolPresetDto extends KolFieldsDto {
  @IsString()
  @MaxLength(120)
  declare name: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_WALLETS)
  @ValidateNested({ each: true })
  @Type(() => WalletRefDto)
  wallets?: WalletRefDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_TAGS)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  squads?: string[];
}

/** Atualiza um KOL do preset global. Campo ausente = não mexe. */
export class UpdateKolPresetDto extends KolFieldsDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_WALLETS)
  @ValidateNested({ each: true })
  @Type(() => WalletRefDto)
  wallets?: WalletRefDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_TAGS)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  squads?: string[];
}

// ── Override (usuário logado) ────────────────────────────────────────────────

/** Edições do usuário sobre um KOL, na conta dele. `null` volta a herdar. */
export class UpdateKolOverrideDto extends KolFieldsDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_TAGS)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  fnfGroups?: string[] | null;

  /**
   * Lista EFETIVA de carteiras desejada. O servidor deriva `walletsAdded` e
   * `walletsRemoved` contra o preset — o cliente não precisa mais conhecer a
   * camada base só para calcular esse diff.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_WALLETS)
  @ValidateNested({ each: true })
  @Type(() => WalletRefDto)
  wallets?: WalletRefDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_WALLETS)
  @ValidateNested({ each: true })
  @Type(() => WalletRefDto)
  walletsAdded?: WalletRefDto[] | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_WALLETS)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  walletsRemoved?: string[] | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_WALLETS)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  dismissedSidewallets?: string[] | null;

  /** Esconde da coleção do usuário um KOL que veio do preset. */
  @IsOptional()
  @IsBoolean()
  deleted?: boolean;
}

/**
 * Consulta do índice. O merge `preset + override`, os filtros, as contagens e a
 * paginação passaram para o SERVIDOR: mandar o índice inteiro (73 KB hoje, e
 * linear no tamanho do preset) a cada page load e filtrar no cliente é
 * exatamente o que o projeto evita.
 */
export class KolQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @IsIn(['all', 'unclassified', 'alphaUp', 'noTwitter', 'pendingScan'])
  view?: 'all' | 'unclassified' | 'alphaUp' | 'noTwitter' | 'pendingScan';

  /** Listas separadas por vírgula (facetas da rail). */
  @IsOptional() @IsString() @MaxLength(400) tiers?: string;
  @IsOptional() @IsString() @MaxLength(400) types?: string;
  @IsOptional() @IsString() @MaxLength(800) squads?: string;
  @IsOptional() @IsString() @MaxLength(800) groups?: string;

  @IsOptional()
  @IsIn(['relevance', 'name', 'wallets', 'tier'])
  sort?: 'relevance' | 'name' | 'wallets' | 'tier';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

/** Consulta do preset na tela de admin — busca e paginação são do servidor. */
export class KolPresetQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

/** Cria um KOL que existe SÓ na conta do usuário. */
export class CreateKolCustomDto {
  @IsString()
  @MaxLength(120)
  name: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => WalletRefDto)
  wallet?: WalletRefDto;
}

// ── Grupos / FnFs (usuário logado) ───────────────────────────────────────────

export class KolGroupDto {
  @IsString()
  @MaxLength(80)
  name: string;
}

// ── Backup da conta (export/import) ──────────────────────────────────────────

/** Um override do backup — o `kolId` viaja no corpo, não na URL. */
class ImportOverrideDto extends UpdateKolOverrideDto {
  @IsString()
  @MaxLength(120)
  kolId: string;
}

/** Grupo do backup. O `id` é o do arquivo e serve só para remapear `fnfGroups`. */
class ImportGroupDto {
  @IsString()
  @MaxLength(80)
  id: string;

  @IsString()
  @MaxLength(80)
  name: string;
}

/**
 * Restaura um backup na conta. Os grupos são recriados POR NOME (o id do arquivo
 * não vale nesta conta) e as referências em `fnfGroups` são remapeadas para os
 * ids novos — importar o backup de outra conta não deixa ponteiro solto.
 */
export class ImportKolBackupDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => ImportOverrideDto)
  overrides?: ImportOverrideDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ImportGroupDto)
  groups?: ImportGroupDto[];
}
