import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CapturedMessage, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { processAvatar } from '../users/avatar.util';
import {
  CreateFavoriteDto,
  FavoritesFeedQueryDto,
  UpdateFavoriteDto,
} from './dto/favorite.dto';

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

/**
 * Projeção pública do favorito: NUNCA seleciona `photoData`/`photoMime` (bytes),
 * que jamais trafegam em JSON — a foto é servida por endpoint dedicado. Expõe
 * `photoUpdatedAt` só como sinal de presença/cache-busting.
 */
const FAVORITE_SELECT = {
  id: true,
  authorId: true,
  authorTag: true,
  followed: true,
  nickname: true,
  color: true,
  photoUpdatedAt: true,
  createdAt: true,
} satisfies Prisma.FavoriteAuthorSelect;

type FavoriteRow = Prisma.FavoriteAuthorGetPayload<{
  select: typeof FAVORITE_SELECT;
}>;

/** Campos de personalização — servem tanto ao create quanto ao update do upsert. */
interface PersonalizationFields {
  nickname?: string | null;
  color?: string | null;
  photoData?: Uint8Array<ArrayBuffer>;
  photoMime?: string;
  photoUpdatedAt?: Date;
}

/** Favorito serializável (sem bytes) + URL absoluta da foto (ou null). */
export interface FavoriteDto {
  id: string;
  authorId: string;
  authorTag: string | null;
  /** `false` = só personalizado (não segue) — não entra no feed de favoritos. */
  followed: boolean;
  nickname: string | null;
  color: string | null;
  photoUrl: string | null;
  createdAt: Date;
}

/**
 * Autores favoritos ("seguidos") por conta. Identidade estável pelo snowflake
 * (`authorId`); idempotente por (userId, authorId). O feed de favoritos é
 * server-side (todas as mensagens dos seguidos, paginadas por recência), usando
 * o índice `[authorId, createdAt]` da `CapturedMessage`.
 */
@Injectable()
export class FavoritesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private apiBaseUrl(): string {
    return (
      this.config.get<string>('API_PUBLIC_URL') || 'http://localhost:3333'
    ).replace(/\/$/, '');
  }

  /** Mapeia a linha para o DTO público (deriva a URL da foto; sem bytes). */
  private toDto(f: FavoriteRow): FavoriteDto {
    return {
      id: f.id,
      authorId: f.authorId,
      authorTag: f.authorTag,
      followed: f.followed,
      nickname: f.nickname,
      color: f.color,
      createdAt: f.createdAt,
      // `?v=` invalida o cache do <img> quando a foto muda.
      photoUrl: f.photoUpdatedAt
        ? `${this.apiBaseUrl()}/api/v1/feed/favorites/photo/${f.id}?v=${f.photoUpdatedAt.getTime()}`
        : null,
    };
  }

  /**
   * Lista os autores SEGUIDOS e os apenas PERSONALIZADOS (mais recentes
   * primeiro). O cliente usa a lista inteira para pintar os cards e filtra por
   * `followed` no painel "Seus favoritos".
   */
  async list(userId: string): Promise<FavoriteDto[]> {
    const rows = await this.prisma.getReadClient().favoriteAuthor.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: FAVORITE_SELECT,
    });
    return rows.map((r) => this.toDto(r));
  }

  /**
   * Segue um autor (idempotente). Atualiza a `authorTag` conhecida no re-follow.
   * `upsert` na chave única evita corrida e duplicidade.
   */
  async add(userId: string, dto: CreateFavoriteDto): Promise<FavoriteDto> {
    const authorTag = dto.authorTag ?? null;
    const row = await this.prisma.getWriteClient().favoriteAuthor.upsert({
      where: { userId_authorId: { userId, authorId: dto.authorId } },
      create: { userId, authorId: dto.authorId, authorTag, followed: true },
      // Re-follow de um autor só personalizado reaproveita a linha.
      update: { authorTag, followed: true },
      select: FAVORITE_SELECT,
    });
    return this.toDto(row);
  }

  /**
   * Personaliza um autor (apelido + cor) — SEM exigir follow: se ainda não há
   * linha, ela nasce com `followed=false`. Escopo garantido pela chave única
   * `(userId, authorId)`. Campos ausentes não mudam; `null`/apelido vazio limpam.
   */
  async update(
    userId: string,
    authorId: string,
    dto: UpdateFavoriteDto,
  ): Promise<FavoriteDto> {
    const data: PersonalizationFields = {};
    if (dto.nickname !== undefined) {
      const trimmed = dto.nickname?.trim();
      data.nickname = trimmed ? trimmed : null;
    }
    if (dto.color !== undefined) data.color = dto.color ?? null;

    return this.writeScoped(userId, authorId, dto.authorTag ?? null, data);
  }

  /**
   * Salva a foto do avatar do favorito: re-codifica em webp (sharp) e guarda os
   * bytes NOSSOS. Entrada não-imagem/corrompida faz `processAvatar` lançar (→ 400
   * no controller). Escopo pela chave única.
   */
  async setPhoto(
    userId: string,
    authorId: string,
    source: Buffer,
  ): Promise<FavoriteDto> {
    let processed: Awaited<ReturnType<typeof processAvatar>>;
    try {
      processed = await processAvatar(source);
    } catch {
      throw new BadRequestException('Imagem inválida');
    }
    const { data, mime } = processed;
    // `authorTag` null → o upsert cai na chave (que já é a tag do autor).
    return this.writeScoped(userId, authorId, null, {
      photoData: new Uint8Array(data),
      photoMime: mime,
      photoUpdatedAt: new Date(),
    });
  }

  /**
   * Grava personalização escopada por (userId, authorId). É UPSERT: personalizar
   * não exige seguir, e a linha criada aqui nasce com `followed=false` (some do
   * feed de favoritos, mas pinta os cards do autor).
   */
  private async writeScoped(
    userId: string,
    authorId: string,
    authorTag: string | null,
    data: PersonalizationFields,
  ): Promise<FavoriteDto> {
    const row = await this.prisma.getWriteClient().favoriteAuthor.upsert({
      where: { userId_authorId: { userId, authorId } },
      // A chave de follow JÁ é a tag do autor — usada como exibição no fallback.
      create: {
        userId,
        authorId,
        authorTag: authorTag ?? authorId,
        followed: false,
        ...data,
      },
      update: data,
      select: FAVORITE_SELECT,
    });
    return this.toDto(row);
  }

  /**
   * Bytes da foto de um favorito, pela chave `id` (cuid, não enumerável) — público
   * como o avatar de usuário (a foto não é secreta; é o que iria num `<img>`).
   */
  async getPhoto(id: string): Promise<{ data: Buffer; mime: string } | null> {
    const f = await this.prisma.getReadClient().favoriteAuthor.findUnique({
      where: { id },
      select: { photoData: true, photoMime: true },
    });
    if (!f?.photoData) return null;
    return { data: Buffer.from(f.photoData), mime: f.photoMime || 'image/webp' };
  }

  /**
   * Deixa de seguir. Idempotente: silencioso se não existia. A linha SOBREVIVE
   * (como `followed=false`) quando há personalização — desfazer o follow não pode
   * apagar o apelido/cor/foto que o usuário deu ao autor.
   */
  async remove(userId: string, authorId: string): Promise<{ authorId: string }> {
    const write = this.prisma.getWriteClient();
    const row = await write.favoriteAuthor.findUnique({
      where: { userId_authorId: { userId, authorId } },
      select: { id: true, nickname: true, color: true, photoUpdatedAt: true },
    });
    if (!row) return { authorId };

    const personalized = Boolean(row.nickname || row.color || row.photoUpdatedAt);
    if (personalized) {
      await write.favoriteAuthor.update({
        where: { id: row.id },
        data: { followed: false },
      });
    } else {
      await write.favoriteAuthor.deleteMany({ where: { id: row.id } });
    }
    return { authorId };
  }

  /** Feed paginado com as capturas dos autores seguidos (recência). */
  async listMessages(
    userId: string,
    query: FavoritesFeedQueryDto,
  ): Promise<{
    items: CapturedMessage[];
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  }> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(MAX_LIMIT, Math.max(1, query.limit ?? DEFAULT_LIMIT));

    const read = this.prisma.getReadClient();
    // Só os SEGUIDOS: personalizar um autor não o coloca no feed de favoritos.
    const favorites = await read.favoriteAuthor.findMany({
      where: { userId, followed: true },
      select: { authorId: true },
    });
    // A chave de follow é o authorTag (identidade presente em 100% das capturas);
    // guardada na coluna `authorId` do favorito. Casamos por authorTag.
    const keys = favorites.map((f) => f.authorId);

    // Sem favoritos → sem consulta pesada.
    if (keys.length === 0) {
      return { items: [], page, limit, total: 0, totalPages: 0 };
    }

    const where = { authorTag: { in: keys } };
    const [items, total] = await Promise.all([
      read.capturedMessage.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      read.capturedMessage.count({ where }),
    ]);

    return { items, page, limit, total, totalPages: Math.ceil(total / limit) };
  }
}
