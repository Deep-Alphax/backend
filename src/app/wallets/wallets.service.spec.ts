import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Chain, SyncStatus, CatalogRole } from '@prisma/client';
import { WalletsService } from './wallets.service';

const EVM_ADDR = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';
const EVM_CHECKSUM = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const USER = 'user-1';

const catalogDto = (
  over: Partial<{ chain: Chain; address: string; label: string }> = {},
) => ({
  chain: Chain.ETHEREUM,
  address: EVM_ADDR,
  ...over,
});

/** Entrada de catálogo no shape que o CATALOG_SELECT devolve. */
const entry = (over: Record<string, unknown> = {}) => ({
  role: CatalogRole.TRACKED,
  label: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  wallet: {
    id: 'w1',
    chain: Chain.ETHEREUM,
    chainType: 'EVM',
    address: EVM_CHECKSUM,
    isActive: true,
    syncStatus: SyncStatus.PENDING,
    lastSyncedAt: null,
    firstTxAt: null,
  },
  ...over,
});

function makeService() {
  const client = {
    wallet: {
      upsert: jest.fn().mockResolvedValue({ id: 'w1' }),
      update: jest.fn().mockResolvedValue({ id: 'w1' }),
    },
    walletCatalog: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn().mockResolvedValue(entry()),
      delete: jest.fn().mockResolvedValue({}),
    },
  };
  const prisma: any = {
    getReadClient: () => client,
    getWriteClient: () => client,
  };
  const walletSync: any = { ensureFresh: jest.fn().mockResolvedValue(true) };
  const service = new WalletsService(prisma, walletSync);
  return { service, client, walletSync };
}

describe('WalletsService', () => {
  describe('catalogWallet', () => {
    it('SEM assinatura: upsert da carteira canônica por (chain, addressNorm) + entrada de catálogo', async () => {
      const { service, client } = makeService();
      const res = await service.catalogWallet(
        USER,
        catalogDto({ label: ' meu ' }),
      );

      // Carteira canônica: upsert pela unique global (não por usuário).
      const upsertArg = client.wallet.upsert.mock.calls[0][0];
      expect(upsertArg.where).toEqual({
        chain_addressNorm: { chain: Chain.ETHEREUM, addressNorm: EVM_ADDR },
      });
      expect(upsertArg.create.address).toBe(EVM_CHECKSUM); // checksum EVM
      expect(upsertArg.create.addressNorm).toBe(EVM_ADDR); // lowercase
      expect(upsertArg.create.syncStatus).toBe(SyncStatus.PENDING);
      // NÃO grava userId na carteira (é compartilhada).
      expect(upsertArg.create.userId).toBeUndefined();

      // Entrada de catálogo: role TRACKED por padrão, rótulo trimado.
      const catArg = client.walletCatalog.upsert.mock.calls[0][0];
      expect(catArg.where).toEqual({
        userId_walletId: { userId: USER, walletId: 'w1' },
      });
      expect(catArg.create.role).toBe(CatalogRole.TRACKED);
      expect(catArg.create.label).toBe('meu');
      expect(res.id).toBe('w1');
      expect(res.role).toBe(CatalogRole.TRACKED);
    });

    it('dispara o gap-fill (ensureFresh) da carteira', async () => {
      const { service, walletSync } = makeService();
      await service.catalogWallet(USER, catalogDto());
      expect(walletSync.ensureFresh).toHaveBeenCalledWith('w1');
    });

    it('cataloga com papel SOURCE quando pedido', async () => {
      const { service, client } = makeService();
      await service.catalogWallet(USER, {
        ...catalogDto(),
        role: CatalogRole.SOURCE,
      });
      expect(client.walletCatalog.upsert.mock.calls[0][0].create.role).toBe(
        CatalogRole.SOURCE,
      );
    });

    it('idempotente: re-catalogar não conta no teto (não checa count)', async () => {
      const { service, client } = makeService();
      client.walletCatalog.findFirst.mockResolvedValue({
        id: 'c1',
        walletId: 'w1',
      });
      await service.catalogWallet(USER, catalogDto());
      expect(client.walletCatalog.count).not.toHaveBeenCalled();
    });

    it('aplica o teto de carteiras catalogadas por usuário', async () => {
      const { service, client } = makeService();
      client.walletCatalog.count.mockResolvedValue(50);
      await expect(service.catalogWallet(USER, catalogDto())).rejects.toThrow(
        /Limite/,
      );
      expect(client.wallet.upsert).not.toHaveBeenCalled();
    });

    it('rejeita endereço inválido com BadRequest (sem tocar no banco)', async () => {
      const { service, client } = makeService();
      await expect(
        service.catalogWallet(USER, catalogDto({ address: '0xbad' })),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(client.wallet.upsert).not.toHaveBeenCalled();
    });
  });

  describe('acesso (catálogo, não posse)', () => {
    it('findOne lança NotFound quando o usuário não cataloga a carteira', async () => {
      const { service, client } = makeService();
      client.walletCatalog.findUnique.mockResolvedValue(null);
      await expect(service.findOne(USER, 'w1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(client.walletCatalog.findUnique.mock.calls[0][0].where).toEqual({
        userId_walletId: { userId: USER, walletId: 'w1' },
      });
    });

    it('update exige a carteira no catálogo antes de escrever', async () => {
      const { service, client } = makeService();
      client.walletCatalog.findUnique.mockResolvedValue(null); // não cataloga
      await expect(
        service.update(USER, 'w1', { label: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(client.walletCatalog.update).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('remove só a entrada de catálogo; desativa a carteira quando fica sem catalogadores', async () => {
      const { service, client } = makeService();
      client.walletCatalog.findUnique.mockResolvedValue({ id: 'c1' }); // cataloga
      client.walletCatalog.count.mockResolvedValue(0); // ninguém mais
      await service.remove(USER, 'w1');
      expect(client.walletCatalog.delete).toHaveBeenCalledWith({
        where: { userId_walletId: { userId: USER, walletId: 'w1' } },
      });
      // 0 catalogadores → desativa a carteira compartilhada (cron para; dados ficam).
      expect(client.wallet.update).toHaveBeenCalledWith({
        where: { id: 'w1' },
        data: { isActive: false },
      });
    });

    it('NÃO desativa a carteira se ainda há outros catalogadores', async () => {
      const { service, client } = makeService();
      client.walletCatalog.findUnique.mockResolvedValue({ id: 'c1' });
      client.walletCatalog.count.mockResolvedValue(2); // outros ainda acompanham
      await service.remove(USER, 'w1');
      expect(client.wallet.update).not.toHaveBeenCalled();
    });
  });

  describe('findAll', () => {
    it('lista as carteiras catalogadas pelo usuário (via join)', async () => {
      const { service, client } = makeService();
      client.walletCatalog.findMany.mockResolvedValue([entry()]);
      const res = await service.findAll(USER);
      expect(client.walletCatalog.findMany.mock.calls[0][0].where).toEqual({
        userId: USER,
      });
      expect(res).toHaveLength(1);
      expect(res[0].id).toBe('w1');
    });
  });
});
