import { NotFoundException } from '@nestjs/common';
import { MetricPeriod, MetricScope, TradeSide } from '@prisma/client';
import { AnalyticsService } from './analytics.service';

const USER = 'user-1';

function makeService() {
  const client = {
    wallet: { findFirst: jest.fn(), findMany: jest.fn() },
    trade: { aggregate: jest.fn(), findMany: jest.fn() },
    metricSnapshot: { findFirst: jest.fn(), update: jest.fn(), create: jest.fn() },
  };
  const prisma: any = { getReadClient: () => client, getWriteClient: () => client };
  return { service: new AnalyticsService(prisma), client };
}

const dec = (s: string) => ({ toString: () => s }); // stub de Prisma.Decimal

describe('AnalyticsService', () => {
  it('walletMetrics lança NotFound quando a carteira não é do usuário', async () => {
    const { service, client } = makeService();
    client.wallet.findFirst.mockResolvedValue(null);
    await expect(
      service.walletMetrics(USER, 'w1', MetricPeriod.D30, 0),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('portfolio sem carteiras devolve resultado vazio sem tocar o cache', async () => {
    const { service, client } = makeService();
    client.wallet.findMany.mockResolvedValue([]);
    const res = await service.portfolioMetrics(USER, MetricPeriod.D30, 0);
    expect(res.totalTrades).toBe(0);
    expect(client.metricSnapshot.findFirst).not.toHaveBeenCalled();
  });

  it('retorna o snapshot cacheado quando o tradesHash bate', async () => {
    const { service, client } = makeService();
    client.wallet.findFirst.mockResolvedValue({ id: 'w1' });
    client.trade.aggregate.mockResolvedValue({ _count: { _all: 3 }, _max: { createdAt: new Date(1000) } });
    client.metricSnapshot.findFirst.mockResolvedValue({
      id: 's1',
      tradesHash: `v3:3:1000:0`,
      data: { totalTrades: 3, cached: true },
    });

    const res: any = await service.walletMetrics(USER, 'w1', MetricPeriod.D30, 0);
    expect(res.cached).toBe(true);
    expect(client.trade.findMany).not.toHaveBeenCalled(); // não recomputou
  });

  it('recomputa e faz UPDATE quando o hash mudou', async () => {
    const { service, client } = makeService();
    client.wallet.findFirst.mockResolvedValue({ id: 'w1' });
    client.trade.aggregate.mockResolvedValue({ _count: { _all: 1 }, _max: { createdAt: new Date(2000) } });
    client.metricSnapshot.findFirst.mockResolvedValue({ id: 's1', tradesHash: 'stale', data: {} });
    client.trade.findMany.mockResolvedValue([
      {
        blockTime: new Date('2026-07-20T10:00:00Z'),
        side: TradeSide.BUY,
        baseMint: 'TOK',
        baseSymbol: 'TOK',
        baseAmount: dec('10'),
        usdValue: dec('10'),
        priceUsd: dec('1'),
        feeUsd: dec('0'),
        priceResolved: true,
      },
    ]);

    const res = await service.walletMetrics(USER, 'w1', MetricPeriod.D30, 0);
    expect(res.totalTrades).toBe(1);
    expect(client.metricSnapshot.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 's1' } }),
    );
    expect(client.metricSnapshot.create).not.toHaveBeenCalled();
  });

  it('cria snapshot novo quando não havia cache (scope WALLET)', async () => {
    const { service, client } = makeService();
    client.wallet.findFirst.mockResolvedValue({ id: 'w1' });
    client.trade.aggregate.mockResolvedValue({ _count: { _all: 0 }, _max: { createdAt: null } });
    client.metricSnapshot.findFirst.mockResolvedValue(null);
    client.trade.findMany.mockResolvedValue([]);

    await service.walletMetrics(USER, 'w1', MetricPeriod.D90, 0);
    const created = client.metricSnapshot.create.mock.calls[0][0].data;
    expect(created.scope).toBe(MetricScope.WALLET);
    expect(created.walletId).toBe('w1');
    expect(created.period).toBe(MetricPeriod.D90);
  });
});
