import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Chain, Prisma, SyncStatus, WalletKind } from '@prisma/client';
import { WalletsService } from './wallets.service';
import { verifyWalletSignature } from './wallet-signature.util';

// A verificação criptográfica é testada em wallet-signature.util.spec.ts; aqui
// mockamos para focar na orquestração (nonce, idempotência, sync, ownership).
jest.mock('./wallet-signature.util', () => ({
  buildVerificationMessage: jest.fn(() => 'verify-message'),
  verifyWalletSignature: jest.fn(() => true),
}));
const mockVerify = verifyWalletSignature as jest.Mock;

const EVM_ADDR = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';
const USER = 'user-1';

/** DTO de create com assinatura (default), sobrescrevível. */
const createDto = (over: Partial<{ chain: Chain; address: string; signature: string; label: string }> = {}) => ({
  chain: Chain.ETHEREUM,
  address: EVM_ADDR,
  signature: 'sig',
  ...over,
});

function makeService() {
  const client = {
    wallet: {
      count: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };
  const prisma: any = {
    getReadClient: () => client,
    getWriteClient: () => client,
  };
  const walletSync: any = { syncWallet: jest.fn().mockResolvedValue(undefined) };
  // Cache do nonce: por padrão devolve a mensagem (verificação "válida").
  const cache: any = {
    get: jest.fn().mockResolvedValue('verify-message'),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
  };
  const service = new WalletsService(prisma, walletSync, cache);
  return { service, client, walletSync, cache };
}

beforeEach(() => {
  mockVerify.mockReturnValue(true);
});

describe('WalletsService', () => {
  describe('requestVerificationNonce', () => {
    it('normaliza o endereço, gera a mensagem e guarda no cache (TTL)', async () => {
      const { service, cache } = makeService();
      const res = await service.requestVerificationNonce(USER, { chain: Chain.ETHEREUM, address: EVM_ADDR });
      expect(res.message).toBe('verify-message');
      expect(cache.set).toHaveBeenCalledTimes(1);
      // chave inclui o addressNorm (lowercase EVM).
      expect(cache.set.mock.calls[0][0]).toContain(EVM_ADDR);
    });
  });

  describe('create', () => {
    it('cria carteira com endereço normalizado e syncStatus PENDING', async () => {
      const { service, client } = makeService();
      client.wallet.count.mockResolvedValue(0);
      client.wallet.create.mockImplementation(({ data }) => Promise.resolve({ id: 'w1', ...data }));

      const res = await service.create(USER, createDto({ label: ' meu ' }));

      const arg = client.wallet.create.mock.calls[0][0].data;
      expect(arg.userId).toBe(USER);
      expect(arg.address).toBe('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'); // checksum
      expect(arg.addressNorm).toBe(EVM_ADDR);
      expect(arg.chainType).toBe('EVM');
      expect(arg.label).toBe('meu'); // trim
      expect(arg.syncStatus).toBe(SyncStatus.PENDING);
      expect(res.id).toBe('w1');
    });

    it('exige a prova de posse: verificação expirada (sem nonce) → BadRequest', async () => {
      const { service, client, cache } = makeService();
      cache.get.mockResolvedValueOnce(undefined); // nonce ausente/expirado
      await expect(service.create(USER, createDto())).rejects.toBeInstanceOf(BadRequestException);
      expect(client.wallet.create).not.toHaveBeenCalled();
    });

    it('rejeita assinatura inválida com Unauthorized (não cadastra)', async () => {
      const { service, client } = makeService();
      mockVerify.mockReturnValueOnce(false);
      await expect(service.create(USER, createDto())).rejects.toBeInstanceOf(UnauthorizedException);
      expect(client.wallet.create).not.toHaveBeenCalled();
    });

    it('consome o nonce (single-use) após verificar', async () => {
      const { service, client, cache } = makeService();
      client.wallet.count.mockResolvedValue(0);
      client.wallet.create.mockImplementation(({ data }: any) => Promise.resolve({ id: 'w1', ...data }));
      await service.create(USER, createDto());
      expect(cache.del).toHaveBeenCalledTimes(1);
    });

    it('dispara a ingestão IMEDIATA da carteira recém-criada (não espera o cron)', async () => {
      const { service, client, walletSync } = makeService();
      client.wallet.count.mockResolvedValue(0);
      client.wallet.create.mockImplementation(({ data }: any) => Promise.resolve({ id: 'w1', ...data }));

      await service.create(USER, createDto());

      expect(walletSync.syncWallet).toHaveBeenCalledTimes(1);
      expect(walletSync.syncWallet.mock.calls[0][0].id).toBe('w1');
    });

    it('idempotente: reconectar carteira já cadastrada devolve a existente (sem recriar)', async () => {
      const { service, client, walletSync } = makeService();
      client.wallet.findFirst.mockResolvedValue({
        id: 'w1',
        kind: WalletKind.OWN,
        syncStatus: SyncStatus.SYNCED,
        chain: Chain.ETHEREUM,
        chainType: 'EVM',
        address: EVM_ADDR,
        label: null,
        isActive: true,
        lastSyncedAt: null,
        firstTxAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const res = await service.create(USER, createDto());

      expect(res.id).toBe('w1');
      expect(client.wallet.create).not.toHaveBeenCalled();
      expect(walletSync.syncWallet).not.toHaveBeenCalled();
    });

    it('idempotente: existente em ERROR re-dispara o sync (destrava), sem recriar', async () => {
      const { service, client, walletSync } = makeService();
      client.wallet.findFirst.mockResolvedValue({
        id: 'w1',
        kind: WalletKind.OWN,
        syncStatus: SyncStatus.ERROR,
        chain: Chain.ETHEREUM,
        chainType: 'EVM',
        address: EVM_ADDR,
        label: null,
        isActive: true,
        lastSyncedAt: null,
        firstTxAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await service.create(USER, createDto());

      expect(client.wallet.create).not.toHaveBeenCalled();
      expect(walletSync.syncWallet).toHaveBeenCalledTimes(1);
    });

    it('rejeita endereço inválido com BadRequest', async () => {
      const { service, client } = makeService();
      client.wallet.count.mockResolvedValue(0);
      await expect(
        service.create(USER, createDto({ address: '0xbad' })),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(client.wallet.create).not.toHaveBeenCalled();
    });

    it('aplica o teto de carteiras por usuário', async () => {
      const { service, client } = makeService();
      client.wallet.count.mockResolvedValue(50);
      await expect(service.create(USER, createDto())).rejects.toThrow(/Limite/);
      expect(client.wallet.create).not.toHaveBeenCalled();
    });

    it('converte violação de unique (P2002) em Conflict', async () => {
      const { service, client } = makeService();
      client.wallet.count.mockResolvedValue(1);
      client.wallet.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: '6' }),
      );
      await expect(service.create(USER, createDto())).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('ownership', () => {
    it('findOne lança NotFound quando a carteira não é do usuário', async () => {
      const { service, client } = makeService();
      client.wallet.findFirst.mockResolvedValue(null);
      await expect(service.findOne(USER, 'w1')).rejects.toBeInstanceOf(NotFoundException);
      expect(client.wallet.findFirst.mock.calls[0][0].where).toEqual({
        id: 'w1',
        userId: USER,
        kind: WalletKind.OWN,
      });
    });

    it('update exige ownership (assertOwnership) antes de escrever', async () => {
      const { service, client } = makeService();
      client.wallet.findFirst.mockResolvedValue(null); // não é dono
      await expect(service.update(USER, 'w1', { label: 'x' })).rejects.toBeInstanceOf(NotFoundException);
      expect(client.wallet.update).not.toHaveBeenCalled();
    });

    it('remove exige ownership', async () => {
      const { service, client } = makeService();
      client.wallet.findFirst.mockResolvedValue(null);
      await expect(service.remove(USER, 'w1')).rejects.toBeInstanceOf(NotFoundException);
      expect(client.wallet.delete).not.toHaveBeenCalled();
    });
  });

  describe('requestResync', () => {
    it('marca PENDING e limpa syncError quando é dono', async () => {
      const { service, client } = makeService();
      client.wallet.findFirst.mockResolvedValue({ id: 'w1' });
      client.wallet.update.mockResolvedValue({ id: 'w1', syncStatus: SyncStatus.PENDING });
      await service.requestResync(USER, 'w1');
      expect(client.wallet.update.mock.calls[0][0].data).toEqual({
        syncStatus: SyncStatus.PENDING,
        syncError: null,
      });
    });
  });

  describe('findAll', () => {
    it('lista só as carteiras do usuário', async () => {
      const { service, client } = makeService();
      client.wallet.findMany.mockResolvedValue([{ id: 'w1' }]);
      const res = await service.findAll(USER);
      expect(client.wallet.findMany.mock.calls[0][0].where).toEqual({
        userId: USER,
        kind: WalletKind.OWN,
      });
      expect(res).toHaveLength(1);
    });
  });
});
