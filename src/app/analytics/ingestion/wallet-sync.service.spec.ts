import { SyncStatus, TradeSide, ChainType, Chain, WalletKind } from '@prisma/client';
import { WalletSyncService } from './wallet-sync.service';
import { ProviderRequestError } from '../providers/market-data-provider.interface';

function makeService() {
  const client = {
    wallet: { update: jest.fn().mockResolvedValue({}), findMany: jest.fn() },
    trade: { createMany: jest.fn() },
    metricSnapshot: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
  };
  const prisma: any = { getReadClient: () => client, getWriteClient: () => client };
  const provider: any = { fetchSwaps: jest.fn() };
  const events: any = { emit: jest.fn() };
  return { service: new WalletSyncService(prisma, provider, events), client, provider, events };
}

const wallet: any = {
  id: 'w1',
  userId: 'u1',
  kind: WalletKind.OWN,
  chain: Chain.ETHEREUM,
  chainType: ChainType.EVM,
  address: '0xabc',
  lastSyncedAt: null,
  firstTxAt: null,
  syncCursor: null,
};

const swap = (offMin: number) => ({
  txHash: '0x' + offMin,
  blockTime: new Date('2026-07-01T10:00:00Z').getTime() + offMin * 60000,
  side: TradeSide.BUY,
  baseMint: 'TOK',
  baseAmount: '1',
  quoteMint: 'USDC',
  quoteAmount: '1',
  usdValue: '1',
  priceUsd: '1',
});
// blockTime precisa ser Date no ProviderSwap; ajusta:
const mkSwap = (offMin: number) => ({ ...swap(offMin), blockTime: new Date(swap(offMin).blockTime) });

describe('WalletSyncService', () => {
  it('pagina até o cursor acabar e persiste os trades idempotentemente', async () => {
    const { service, client, provider } = makeService();
    provider.fetchSwaps
      .mockResolvedValueOnce({ swaps: [mkSwap(0), mkSwap(1)], nextCursor: 'c2' })
      .mockResolvedValueOnce({ swaps: [mkSwap(2)], nextCursor: null });
    client.trade.createMany.mockResolvedValueOnce({ count: 2 }).mockResolvedValueOnce({ count: 1 });

    await service.syncWallet(wallet);

    expect(provider.fetchSwaps).toHaveBeenCalledTimes(2);
    expect(client.trade.createMany).toHaveBeenCalledTimes(2);
    // createMany usa skipDuplicates (idempotência).
    expect(client.trade.createMany.mock.calls[0][0].skipDuplicates).toBe(true);

    // Última atualização = SYNCED com firstTxAt = menor blockTime.
    const lastUpdate = client.wallet.update.mock.calls[client.wallet.update.mock.calls.length - 1][0].data;
    expect(lastUpdate.syncStatus).toBe(SyncStatus.SYNCED);
    expect(lastUpdate.firstTxAt).toEqual(mkSwap(0).blockTime);
    expect(lastUpdate.syncCursor).toBeNull();
  });

  it('invalida snapshots quando inseriu trades novos', async () => {
    const { service, client, provider } = makeService();
    provider.fetchSwaps.mockResolvedValueOnce({ swaps: [mkSwap(0)], nextCursor: null });
    client.trade.createMany.mockResolvedValueOnce({ count: 1 });

    await service.syncWallet(wallet);
    expect(client.metricSnapshot.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u1', OR: [{ walletId: 'w1' }, { scope: 'PORTFOLIO' }] },
    });
  });

  it('carteira SOURCE: NÃO invalida snapshots do usuário, mas emite wallet.synced', async () => {
    const { service, client, provider, events } = makeService();
    provider.fetchSwaps.mockResolvedValueOnce({ swaps: [mkSwap(0)], nextCursor: null });
    client.trade.createMany.mockResolvedValueOnce({ count: 1 });

    await service.syncWallet({ ...wallet, kind: WalletKind.SOURCE });

    // Trades de fonte não entram nas métricas do usuário → sem invalidação.
    expect(client.metricSnapshot.deleteMany).not.toHaveBeenCalled();
    // Mas mudam a atribuição → evento emitido com kind=SOURCE e inserted>0.
    expect(events.emit).toHaveBeenCalledWith('wallet.synced', {
      userId: 'u1',
      walletId: 'w1',
      kind: WalletKind.SOURCE,
      inserted: 1,
    });
  });

  it('carteira OWN: emite wallet.synced ao inserir trades', async () => {
    const { service, provider, client, events } = makeService();
    provider.fetchSwaps.mockResolvedValueOnce({ swaps: [mkSwap(0)], nextCursor: null });
    client.trade.createMany.mockResolvedValueOnce({ count: 1 });

    await service.syncWallet(wallet);
    expect(events.emit).toHaveBeenCalledWith('wallet.synced', {
      userId: 'u1',
      walletId: 'w1',
      kind: WalletKind.OWN,
      inserted: 1,
    });
  });

  it('NÃO invalida snapshots quando nada novo entrou', async () => {
    const { service, client, provider } = makeService();
    provider.fetchSwaps.mockResolvedValueOnce({ swaps: [mkSwap(0)], nextCursor: null });
    client.trade.createMany.mockResolvedValueOnce({ count: 0 }); // tudo duplicado

    await service.syncWallet(wallet);
    expect(client.metricSnapshot.deleteMany).not.toHaveBeenCalled();
  });

  it('marca ERROR e propaga quando o provider falha', async () => {
    const { service, client, provider } = makeService();
    provider.fetchSwaps.mockRejectedValueOnce(new Error('boom'));

    await expect(service.syncWallet(wallet)).rejects.toThrow('boom');
    const lastUpdate = client.wallet.update.mock.calls[client.wallet.update.mock.calls.length - 1][0].data;
    expect(lastUpdate.syncStatus).toBe(SyncStatus.ERROR);
    expect(lastUpdate.syncError).toContain('boom');
  });

  it('falha TRANSITÓRIA (429): incrementa tentativa e agenda retry (backoff futuro)', async () => {
    const { service, client, provider } = makeService();
    provider.fetchSwaps.mockRejectedValueOnce(new ProviderRequestError('limite', 429));

    await expect(service.syncWallet(wallet)).rejects.toBeInstanceOf(ProviderRequestError);
    const data = client.wallet.update.mock.calls[client.wallet.update.mock.calls.length - 1][0].data;
    expect(data.syncStatus).toBe(SyncStatus.ERROR);
    expect(data.syncAttempts).toBe(1);
    expect(data.nextRetryAt).toBeInstanceOf(Date);
    expect(data.nextRetryAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('falha PERMANENTE (400): NÃO agenda retry (nextRetryAt=null)', async () => {
    const { service, client, provider } = makeService();
    provider.fetchSwaps.mockRejectedValueOnce(new ProviderRequestError('endereço inválido', 400));

    await expect(service.syncWallet(wallet)).rejects.toBeInstanceOf(ProviderRequestError);
    const data = client.wallet.update.mock.calls[client.wallet.update.mock.calls.length - 1][0].data;
    expect(data.syncStatus).toBe(SyncStatus.ERROR);
    expect(data.nextRetryAt).toBeNull();
  });

  it('teto de tentativas: transitório na última tentativa não reagenda', async () => {
    const { service, client, provider } = makeService();
    provider.fetchSwaps.mockRejectedValueOnce(new ProviderRequestError('5xx', 503));

    // syncAttempts=5 → a 6ª falha atinge o teto (MAX=6): sem novo retry.
    await expect(
      service.syncWallet({ ...wallet, syncAttempts: 5 }),
    ).rejects.toBeInstanceOf(ProviderRequestError);
    const data = client.wallet.update.mock.calls[client.wallet.update.mock.calls.length - 1][0].data;
    expect(data.syncAttempts).toBe(6);
    expect(data.nextRetryAt).toBeNull();
  });

  it('sucesso zera o estado de retry (syncAttempts=0, nextRetryAt=null)', async () => {
    const { service, client, provider } = makeService();
    provider.fetchSwaps.mockResolvedValueOnce({ swaps: [mkSwap(0)], nextCursor: null });
    client.trade.createMany.mockResolvedValueOnce({ count: 1 });

    await service.syncWallet({ ...wallet, syncAttempts: 3 });
    const data = client.wallet.update.mock.calls[client.wallet.update.mock.calls.length - 1][0].data;
    expect(data.syncStatus).toBe(SyncStatus.SYNCED);
    expect(data.syncAttempts).toBe(0);
    expect(data.nextRetryAt).toBeNull();
  });

  it('drainPending também busca carteiras ERROR com backoff vencido', async () => {
    const { service, client } = makeService();
    client.wallet.findMany.mockResolvedValue([]);

    await service.drainPending();
    const where = client.wallet.findMany.mock.calls[0][0].where;
    expect(where.isActive).toBe(true);
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { syncStatus: SyncStatus.PENDING },
        expect.objectContaining({ syncStatus: SyncStatus.ERROR }),
      ]),
    );
  });

  it('INCREMENTAL: passa sinceBlockTime=lastSyncedAt quando já sincronizou (cursor null)', async () => {
    const { service, provider } = makeService();
    const lastSyncedAt = new Date('2026-07-01T00:00:00Z');
    provider.fetchSwaps.mockResolvedValueOnce({ swaps: [], nextCursor: null });
    await service.syncWallet({ ...wallet, lastSyncedAt, syncCursor: null });
    expect(provider.fetchSwaps.mock.calls[0][0].sinceBlockTime).toEqual(lastSyncedAt);
  });

  it('BACKFILL: NÃO filtra por data ao retomar (syncCursor setado) e continua do cursor', async () => {
    const { service, provider } = makeService();
    provider.fetchSwaps.mockResolvedValueOnce({ swaps: [], nextCursor: null });
    await service.syncWallet({ ...wallet, lastSyncedAt: new Date('2026-07-01Z'), syncCursor: 'cur-123' });
    const arg = provider.fetchSwaps.mock.calls[0][0];
    expect(arg.sinceBlockTime).toBeNull();
    expect(arg.cursor).toBe('cur-123');
  });

  it('drainPending respeita o guard de execução concorrente', async () => {
    const { service, client } = makeService();
    client.wallet.findMany.mockResolvedValue([]);
    (service as any).running = true; // simula execução em andamento
    await service.drainPending();
    expect(client.wallet.findMany).not.toHaveBeenCalled();
  });
});
