import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Role } from '@prisma/client';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../../prisma/prisma.service';
import { processAvatar, MAX_SOURCE_BYTES } from './avatar.util';

/** Projeção mínima necessária para hidratar o avatar. */
interface AvatarUser {
  id: string;
  avatarUrl: string | null;
  avatarData: Uint8Array | null;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Define a role de um usuário pelo EMAIL (admin) — promove/rebaixa sem mexer no
   * banco à mão. Busca case-insensitive. Retorna a projeção pública.
   */
  async setRoleByEmail(
    email: string,
    role: Role,
  ): Promise<{ id: string; email: string; role: Role }> {
    const user = await this.prisma.getReadClient().user.findFirst({
      where: { email: { equals: email.trim(), mode: 'insensitive' } },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('Usuário não encontrado');
    return this.prisma.getWriteClient().user.update({
      where: { id: user.id },
      data: { role },
      select: { id: true, email: true, role: true },
    });
  }

  private apiBaseUrl(): string {
    return (
      this.config.get<string>('API_PUBLIC_URL') || 'http://localhost:3333'
    ).replace(/\/$/, '');
  }

  /** URL absoluta do nosso endpoint de avatar para um usuário. */
  avatarEndpoint(userId: string): string {
    return `${this.apiBaseUrl()}/api/v1/users/${userId}/avatar`;
  }

  /**
   * Baixa a foto do Google e re-hospeda como bytes NOSSOS (best-effort), apontando
   * `avatarUrl` para o nosso endpoint. Só baixa quando ainda não temos imagem
   * (evita re-download a cada login). Nunca lança: falha → fallback para a URL do
   * Google (melhor que nada). Devolve o usuário (possivelmente) atualizado.
   */
  async hydrateGoogleAvatar<T extends AvatarUser>(
    user: T,
    pictureUrl?: string | null,
  ): Promise<T> {
    const write = this.prisma.getWriteClient();
    const endpoint = this.avatarEndpoint(user.id);

    // Já hospedado por nós → só garante que avatarUrl aponta para o endpoint.
    if (user.avatarData) {
      if (user.avatarUrl === endpoint) return user;
      return write.user.update({
        where: { id: user.id },
        data: { avatarUrl: endpoint },
      }) as unknown as T;
    }

    if (!pictureUrl) return user;

    try {
      const resp = await firstValueFrom(
        this.http.get<ArrayBuffer>(pictureUrl, {
          responseType: 'arraybuffer',
          timeout: 5000,
          maxContentLength: MAX_SOURCE_BYTES,
          maxRedirects: 2,
        }),
      );
      const { data, mime } = await processAvatar(Buffer.from(resp.data));
      return write.user.update({
        where: { id: user.id },
        // new Uint8Array(...): Prisma Bytes espera Uint8Array<ArrayBuffer> (o Buffer
        // do sharp é Uint8Array<ArrayBufferLike> e não casa no tipo).
        data: {
          avatarData: new Uint8Array(data),
          avatarMime: mime,
          avatarUrl: endpoint,
        },
      }) as unknown as T;
    } catch (err: any) {
      this.logger.warn(
        `Não foi possível re-hospedar o avatar do Google (user ${user.id}): ${err?.message}`,
      );
      // Fallback: mantém a URL do Google para ao menos exibir algo.
      if (user.avatarUrl === pictureUrl) return user;
      return write.user.update({
        where: { id: user.id },
        data: { avatarUrl: pictureUrl },
      }) as unknown as T;
    }
  }

  /** Bytes do avatar re-hospedado para servir. null quando não há imagem armazenada. */
  async getAvatar(
    userId: string,
  ): Promise<{ data: Buffer; mime: string } | null> {
    const u = await this.prisma.getReadClient().user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { avatarData: true, avatarMime: true },
    });
    if (!u?.avatarData) return null;
    return {
      data: Buffer.from(u.avatarData),
      mime: u.avatarMime || 'image/webp',
    };
  }
}
