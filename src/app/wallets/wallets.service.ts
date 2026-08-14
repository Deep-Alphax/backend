import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { Prisma, SyncStatus, CatalogRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { WalletSyncService } from '../analytics/ingestion/wallet-sync.service';
import { CatalogWalletDto, UpdateWalletDto } from './dto/wallet.dto';
import { normalizeWalletAddress } from './wallet-address.util';

/** Projeção pública da carteira canônica (esconde cursor/erro internos de sync). */
const WALLET_SELECT = {
  id: true,
  chain: true,
  chainType: true,
  address: true,
  isActive: true,
  syncStatus: true,
  lastSyncedAt: true,
  firstTxAt: true,
} satisfies Prisma.WalletSelect;

/** Entrada de catálogo + carteira, projetada para o formato público. */
const CATALOG_SELECT = {
  role: true,
  label: true,
  createdAt: true,
  updatedAt: true,
  wallet: { select: WALLET_SELECT },
} satisfies Prisma.WalletCatalogSelect;

@Injectable()
export class WalletsService {
  private readonly logger = new Logger(WalletsService.name);

  /** Teto de carteiras catalogadas por usuário — barra abuso/enumeração. */
  private static readonly MAX_WALLETS_PER_USER = 50;

  constructor(
    private readonly prisma: PrismaService,
    private readonly walletSync: WalletSyncService,
  ) {}

  /** Achata a entrada de catálogo + carteira canônica no formato público. */
  private toPublic(entry: {
    role: CatalogRole;
    label: string | null;
    createdAt: Date;
    updatedAt: Date;
    wallet: {
      id: string;
      chain: string;
      chainType: string;
      address: string;
      isActive: boolean;
      syncStatus: SyncStatus;
      lastSyncedAt: Date | null;
      firstTxAt: Date | null;
    };
  }) {
    return {
      id: entry.wallet.id,
      chain: entry.wallet.chain,
      chainType: entry.wallet.chainType,
      address: entry.wallet.address,
      label: entry.label, // rótulo é POR USUÁRIO (vive no catálogo)
      role: entry.role,
      isActive: entry.wallet.isActive,
      syncStatus: entry.wallet.syncStatus,
      lastSyncedAt: entry.wallet.lastSyncedAt,
      firstTxAt: entry.wallet.firstTxAt,
      createdAt: entry.createdAt, // quando o usuário catalogou
      updatedAt: entry.updatedAt,
    };
  }

  /**
   * Busca/cataloga uma carteira na conta do usuário. SEM assinatura/posse: catalogar
   * é só um bookmark de um endereço público. Os dados on-chain são COMPARTILHADOS —
   * um único registro canônico por (chain, addressNorm), reusado por todos. Se a
   * carteira nunca foi sincronizada, ou está stale, dispara o sync (preenche a lacuna).
   */
  async catalogWallet(userId: string, dto: CatalogWalletDto) {
    let normalized;
    try {
      normalized = normalizeWalletAddress(dto.chain, dto.address);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }

    const write = this.prisma.getWriteClient();
    const role = dto.role ?? CatalogRole.TRACKED;

    // Já catalogada? Re-buscar a mesma carteira é idempotente e não conta no cap.
    const existing = await write.walletCatalog.findFirst({
      where: {
        userId,
        wallet: { chain: dto.chain, addressNorm: normalized.addressNorm },
      },
      select: { id: true },
    });

    if (!existing) {
      const count = await write.walletCatalog.count({ where: { userId } });
      if (count >= WalletsService.MAX_WALLETS_PER_USER) {
        throw new BadRequestException(
          `Limite de ${WalletsService.MAX_WALLETS_PER_USER} carteiras por conta atingido.`,
        );
      }
    }

    // Upsert da carteira CANÔNICA (compartilhada) por (chain, addressNorm).
    const wallet = await write.wallet.upsert({
      where: {
        chain_addressNorm: {
          chain: dto.chain,
          addressNorm: normalized.addressNorm,
        },
      },
      create: {
        chain: dto.chain,
        chainType: normalized.chainType,
        address: normalized.address,
        addressNorm: normalized.addressNorm,
        isActive: true,
        syncStatus: SyncStatus.PENDING,
      },
      // Recataloga uma carteira antes desativada (0 catalogadores) → reativa o sync.
      update: { isActive: true },
      select: { id: true },
    });

    // Cria/atualiza a entrada de catálogo do usuário.
    const entry = await write.walletCatalog.upsert({
      where: { userId_walletId: { userId, walletId: wallet.id } },
      create: {
        userId,
        walletId: wallet.id,
        role,
        label: dto.label?.trim() || null,
      },
      update: {
        ...(dto.label !== undefined ? { label: dto.label.trim() || null } : {}),
      },
      select: CATALOG_SELECT,
    });

    // Preenche a lacuna (ou faz o backfill inicial) em background — não bloqueia a resposta.
    void this.walletSync.ensureFresh(wallet.id);

    return this.toPublic(entry);
  }

  async findAll(userId: string) {
    const entries = await this.prisma.getReadClient().walletCatalog.findMany({
      where: { userId },
      select: CATALOG_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    return entries.map((e) => this.toPublic(e));
  }

  async findOne(userId: string, walletId: string) {
    const entry = await this.prisma.getReadClient().walletCatalog.findUnique({
      where: { userId_walletId: { userId, walletId } },
      select: CATALOG_SELECT,
    });
    if (!entry) throw new NotFoundException('Carteira não encontrada');
    return this.toPublic(entry);
  }

  async update(userId: string, walletId: string, dto: UpdateWalletDto) {
    await this.assertCataloged(userId, walletId);
    // isActive é da carteira COMPARTILHADA — não deixamos um usuário desativá-la p/ os
    // outros. Aqui só o rótulo POR USUÁRIO (catálogo).
    const entry = await this.prisma.getWriteClient().walletCatalog.update({
      where: { userId_walletId: { userId, walletId } },
      data: {
        ...(dto.label !== undefined ? { label: dto.label.trim() || null } : {}),
      },
      select: CATALOG_SELECT,
    });
    return this.toPublic(entry);
  }

  /**
   * Remove a carteira do catálogo do usuário. NÃO apaga a carteira/trades compartilhados
   * (outros usuários podem catalogá-la). Se sobrar 0 catalogadores, desativa a carteira
   * (o cron para de sincronizá-la), preservando os dados p/ reuso futuro.
   */
  async remove(userId: string, walletId: string) {
    await this.assertCataloged(userId, walletId);
    const write = this.prisma.getWriteClient();
    await write.walletCatalog.delete({
      where: { userId_walletId: { userId, walletId } },
    });
    const remaining = await write.walletCatalog.count({ where: { walletId } });
    if (remaining === 0) {
      await write.wallet.update({
        where: { id: walletId },
        data: { isActive: false },
      });
    }
    return { success: true, message: 'Carteira removida do seu catálogo.' };
  }

  /**
   * Reagenda a sincronização da carteira (marca PENDING). Como é compartilhada, o
   * resync beneficia todos os catalogadores. Zera o orçamento de retry (backoff).
   */
  async requestResync(userId: string, walletId: string) {
    await this.assertCataloged(userId, walletId);
    await this.prisma.getWriteClient().wallet.update({
      where: { id: walletId },
      data: {
        syncStatus: SyncStatus.PENDING,
        syncError: null,
        syncAttempts: 0,
        nextRetryAt: null,
        isActive: true,
      },
    });
    return this.findOne(userId, walletId);
  }

  /** Garante que o usuário CATALOGA a carteira (evita IDOR sobre dados de outro). */
  private async assertCataloged(
    userId: string,
    walletId: string,
  ): Promise<void> {
    const entry = await this.prisma.getReadClient().walletCatalog.findUnique({
      where: { userId_walletId: { userId, walletId } },
      select: { id: true },
    });
    if (!entry) throw new NotFoundException('Carteira não encontrada');
  }
}
