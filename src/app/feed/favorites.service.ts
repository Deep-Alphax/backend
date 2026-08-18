import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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
  nickname: true,
  color: true,
  photoUpdatedAt: true,
  createdAt: true,
} satisfies Prisma.FavoriteAuthorSelect;

type FavoriteRow = Prisma.FavoriteAuthorGetPayload<{
  select: typeof FAVORITE_SELECT;
}>;

/** Favorito serializável (sem bytes) + URL absoluta da foto (ou null). */
export interface FavoriteDto {
  id: string;
  authorId: string;
  authorTag: string | null;
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
      nickname: f.nickname,
      color: f.color,
      createdAt: f.createdAt,
      // `?v=` invalida o cache do <img> quando a foto muda.
      photoUrl: f.photoUpdatedAt
        ? `${this.apiBaseUrl()}/api/v1/feed/favorites/photo/${f.id}?v=${f.photoUpdatedAt.getTime()}`
        : null,
    };
  }

  /** Lista os autores seguidos pelo usuário (mais recentes primeiro). */
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
      create: { userId, authorId: dto.authorId, authorTag },
      update: { authorTag },
      select: FAVORITE_SELECT,
    });
    return this.toDto(row);
  }

  /**
   * Personaliza um favorito (apelido + cor). Escopo garantido pela chave única
   * `(userId, authorId)`. Campos ausentes não mudam; `null`/apelido vazio limpam.
   */
  async update(
    userId: string,
    authorId: string,
    dto: UpdateFavoriteDto,
  ): Promise<FavoriteDto> {
    const data: Prisma.FavoriteAuthorUpdateInput = {};
    if (dto.nickname !== undefined) {
      const trimmed = dto.nickname?.trim();
      data.nickname = trimmed ? trimmed : null;
    }
    if (dto.color !== undefined) data.color = dto.color ?? null;

    return this.writeScoped(userId, authorId, data);
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
    return this.writeScoped(userId, authorId, {
      photoData: new Uint8Array(data),
      photoMime: mime,
      photoUpdatedAt: new Date(),
    });
  }

  /** Update escopado por (userId, authorId); 404 se o favorito não existe. */
  private async writeScoped(
    userId: string,
    authorId: string,
    data: Prisma.FavoriteAuthorUpdateInput,
  ): Promise<FavoriteDto> {
    try {
      const row = await this.prisma.getWriteClient().favoriteAuthor.update({
        where: { userId_authorId: { userId, authorId } },
        data,
        select: FAVORITE_SELECT,
      });
      return this.toDto(row);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        throw new NotFoundException('Favorito não encontrado');
      }
      throw err;
    }
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

  /** Deixa de seguir. Idempotente: silencioso se não existia. */
  async remove(userId: string, authorId: string): Promise<{ authorId: string }> {
    await this.prisma
      .getWriteClient()
      .favoriteAuthor.deleteMany({ where: { userId, authorId } });
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
    const favorites = await read.favoriteAuthor.findMany({
      where: { userId },
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
