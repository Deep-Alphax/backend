import { Injectable } from '@nestjs/common';
import { CapturedMessage, FavoriteAuthor } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateFavoriteDto, FavoritesFeedQueryDto } from './dto/favorite.dto';

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

/**
 * Autores favoritos ("seguidos") por conta. Identidade estável pelo snowflake
 * (`authorId`); idempotente por (userId, authorId). O feed de favoritos é
 * server-side (todas as mensagens dos seguidos, paginadas por recência), usando
 * o índice `[authorId, createdAt]` da `CapturedMessage`.
 */
@Injectable()
export class FavoritesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Lista os autores seguidos pelo usuário (mais recentes primeiro). */
  list(userId: string): Promise<FavoriteAuthor[]> {
    return this.prisma.getReadClient().favoriteAuthor.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Segue um autor (idempotente). Atualiza a `authorTag` conhecida no re-follow.
   * `upsert` na chave única evita corrida e duplicidade.
   */
  add(userId: string, dto: CreateFavoriteDto): Promise<FavoriteAuthor> {
    const authorTag = dto.authorTag ?? null;
    return this.prisma.getWriteClient().favoriteAuthor.upsert({
      where: { userId_authorId: { userId, authorId: dto.authorId } },
      create: { userId, authorId: dto.authorId, authorTag },
      update: { authorTag },
    });
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
    const authorIds = favorites.map((f) => f.authorId);

    // Sem favoritos → sem consulta pesada.
    if (authorIds.length === 0) {
      return { items: [], page, limit, total: 0, totalPages: 0 };
    }

    const where = { authorId: { in: authorIds } };
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
