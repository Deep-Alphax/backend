import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
  Logger,
  Inject,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { randomBytes } from 'crypto';
import { Prisma, SyncStatus, WalletKind, Wallet } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { WalletSyncService } from '../analytics/ingestion/wallet-sync.service';
import { CreateWalletDto, UpdateWalletDto, RequestWalletNonceDto } from './dto/wallet.dto';
import { normalizeWalletAddress } from './wallet-address.util';
import { buildVerificationMessage, verifyWalletSignature } from './wallet-signature.util';

/** Projeção pública de uma carteira (esconde cursor/erro internos de sync). */
const WALLET_SELECT = {
  id: true,
  chain: true,
  chainType: true,
  address: true,
  label: true,
  isActive: true,
  syncStatus: true,
  lastSyncedAt: true,
  firstTxAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.WalletSelect;

@Injectable()
export class WalletsService {
  private readonly logger = new Logger(WalletsService.name);

  /** Teto de carteiras por usuário — barra abuso/enumeração e limita custo de sync. */
  private static readonly MAX_WALLETS_PER_USER = 50;
  /** Validade do nonce de verificação (assinatura precisa chegar nessa janela). */
  private static readonly NONCE_TTL_MS = 5 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly walletSync: WalletSyncService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  /** Chave de cache do nonce/mensagem de verificação (por usuário/chain/endereço). */
  private nonceKey(userId: string, chain: string, addressNorm: string): string {
    return `wallet_verify:${userId}:${chain}:${addressNorm}`;
  }

  /**
   * Passo 1 da verificação por assinatura: gera a mensagem (com nonce único) que o
   * usuário vai assinar para provar posse. A mensagem é CONTROLADA pelo servidor
   * (anti-tamper) e guardada em cache (single-use, TTL curto).
   */
  async requestVerificationNonce(userId: string, dto: RequestWalletNonceDto) {
    let normalized;
    try {
      normalized = normalizeWalletAddress(dto.chain, dto.address);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }

    const nonce = randomBytes(16).toString('hex');
    const message = buildVerificationMessage(normalized.address, nonce);
    await this.cache.set(
      this.nonceKey(userId, dto.chain, normalized.addressNorm),
      message,
      WalletsService.NONCE_TTL_MS,
    );
    return { message };
  }

  /** Projeta a carteira completa no formato público (esconde cursor/erro de sync). */
  private toPublicWallet(w: Wallet) {
    return {
      id: w.id,
      chain: w.chain,
      chainType: w.chainType,
      address: w.address,
      label: w.label,
      isActive: w.isActive,
      syncStatus: w.syncStatus,
      lastSyncedAt: w.lastSyncedAt,
      firstTxAt: w.firstTxAt,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    };
  }

  async create(userId: string, dto: CreateWalletDto) {
    // Validação/normalização determinística por chain (checksum EVM / base58 Solana).
    let normalized;
    try {
      normalized = normalizeWalletAddress(dto.chain, dto.address);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }

    // Prova de posse: só cadastra se a assinatura bater com o nonce emitido
    // (server-controlled, single-use). Sem isso, qualquer um cadastraria endereço alheio.
    const nonceKey = this.nonceKey(userId, dto.chain, normalized.addressNorm);
    const message = await this.cache.get<string>(nonceKey);
    if (!message) {
      throw new BadRequestException('Verificação expirada. Conecte a carteira novamente.');
    }
    if (!verifyWalletSignature(normalized.chainType, normalized.address, message, dto.signature)) {
      throw new UnauthorizedException(
        'Assinatura inválida — não foi possível confirmar a posse da carteira.',
      );
    }
    await this.cache.del(nonceKey); // single-use

    const write = this.prisma.getWriteClient();

    // Idempotência: reconectar uma carteira JÁ cadastrada não é erro (o front
    // re-dispara o registro a cada refresh, pois a carteira segue conectada).
    // Devolve a existente em vez de estourar 409, e re-dispara o sync só se ela
    // estava em ERROR (destrava) — sem re-sincronizar à toa nos casos normais.
    const existing = await write.wallet.findFirst({
      where: { userId, chain: dto.chain, addressNorm: normalized.addressNorm },
    });
    if (existing) {
      if (existing.kind !== WalletKind.OWN) {
        throw new ConflictException('Este endereço já está cadastrado como fonte.');
      }
      if (existing.syncStatus === SyncStatus.ERROR) {
        void this.walletSync
          .syncWallet(existing)
          .catch((e) =>
            this.logger.warn(`Re-sync (destravar) falhou p/ wallet ${existing.id}: ${e?.message}`),
          );
      }
      return this.toPublicWallet(existing);
    }

    // Cap por usuário (só carteiras OWN — carteiras de fonte não contam no limite).
    const count = await write.wallet.count({
      where: { userId, kind: WalletKind.OWN },
    });
    if (count >= WalletsService.MAX_WALLETS_PER_USER) {
      throw new BadRequestException(
        `Limite de ${WalletsService.MAX_WALLETS_PER_USER} carteiras por conta atingido.`,
      );
    }

    try {
      const wallet = await write.wallet.create({
        data: {
          userId,
          chain: dto.chain,
          chainType: normalized.chainType,
          address: normalized.address,
          addressNorm: normalized.addressNorm,
          label: dto.label?.trim() || null,
          syncStatus: SyncStatus.PENDING,
        },
      });

      // Ingestão IMEDIATA (não espera o tick do cron, que pode levar até 1 min).
      // Fire-and-forget: a resposta volta já; a sincronização roda em background,
      // emite `wallet.synced` ao inserir trades (invalida os snapshots) e o
      // frontend faz polling do dashboard até os dados aparecerem.
      void this.walletSync
        .syncWallet(wallet)
        .catch((e) =>
          this.logger.warn(`Sync imediato falhou p/ wallet ${wallet.id}: ${e?.message}`),
        );

      return this.toPublicWallet(wallet);
    } catch (error) {
      // Unique (userId, chain, addressNorm): a carteira já existe nessa chain.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Esta carteira já está cadastrada nesta rede.',
        );
      }
      throw error;
    }
  }

  findAll(userId: string) {
    return this.prisma.getReadClient().wallet.findMany({
      where: { userId, kind: WalletKind.OWN }, // só carteiras do usuário (não fontes)
      select: WALLET_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(userId: string, id: string) {
    const wallet = await this.prisma.getReadClient().wallet.findFirst({
      where: { id, userId, kind: WalletKind.OWN }, // ownership: só a própria carteira
      select: WALLET_SELECT,
    });
    if (!wallet) throw new NotFoundException('Carteira não encontrada');
    return wallet;
  }

  async update(userId: string, id: string, dto: UpdateWalletDto) {
    await this.assertOwnership(userId, id);
    return this.prisma.getWriteClient().wallet.update({
      where: { id },
      data: {
        ...(dto.label !== undefined ? { label: dto.label.trim() || null } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
      select: WALLET_SELECT,
    });
  }

  async remove(userId: string, id: string) {
    await this.assertOwnership(userId, id);
    // Cascade (schema) remove trades/positions/snapshots vinculados.
    await this.prisma.getWriteClient().wallet.delete({ where: { id } });
    return { success: true, message: 'Carteira removida.' };
  }

  /**
   * Reagenda a sincronização da carteira (marca PENDING). O worker de ingestão
   * (Fase 5) consome carteiras PENDING. Idempotente enquanto já estiver na fila.
   */
  async requestResync(userId: string, id: string) {
    await this.assertOwnership(userId, id);
    return this.prisma.getWriteClient().wallet.update({
      where: { id },
      // Resync manual zera o orçamento de retry (backoff) — "tentar de novo" de verdade.
      data: {
        syncStatus: SyncStatus.PENDING,
        syncError: null,
        syncAttempts: 0,
        nextRetryAt: null,
      },
      select: WALLET_SELECT,
    });
  }

  /** Garante que a carteira existe E pertence ao usuário (evita IDOR). */
  private async assertOwnership(userId: string, id: string): Promise<void> {
    const owned = await this.prisma.getReadClient().wallet.findFirst({
      where: { id, userId, kind: WalletKind.OWN },
      select: { id: true },
    });
    if (!owned) throw new NotFoundException('Carteira não encontrada');
  }
}
