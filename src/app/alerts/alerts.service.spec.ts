import { ForbiddenException } from '@nestjs/common';
import { AlertKind, Plan } from '@prisma/client';
import { limitsFor } from '../billing/plan-limits';
import { AlertsService } from './alerts.service';

function makeService(plan: Plan, existing: number) {
  const client = {
    alertRule: {
      count: jest.fn(async () => existing),
      create: jest.fn(async ({ data }: any) => ({ id: 'r-new', ...data })),
      findMany: jest.fn(async () => [
        { id: 'old', isActive: true, createdAt: new Date(1) },
        { id: 'new', isActive: true, createdAt: new Date(2) },
      ]),
    },
  };
  const prisma: any = {
    getReadClient: () => client,
    getWriteClient: () => client,
  };
  const entitlements: any = {
    limitsFor: async () => limitsFor(plan),
    planFor: async () => plan,
  };
  return { service: new AlertsService(prisma, entitlements), client };
}

describe('AlertsService — limite por plano', () => {
  it('FREE: a 1ª regra passa, com o termo normalizado', async () => {
    const { service, client } = makeService(Plan.FREE, 0);
    await service.createRule('u1', {
      kind: AlertKind.KEYWORD,
      value: '  $WIF ',
    });
    expect(client.alertRule.create.mock.calls[0][0].data.value).toBe('$wif');
  });

  it('FREE: a 2ª regra é 403 PLAN_LIMIT', async () => {
    const { service, client } = makeService(Plan.FREE, 1);
    const err = await service
      .createRule('u1', { kind: AlertKind.AUTHOR, value: 'ansem' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toMatchObject({
      code: 'PLAN_LIMIT',
      limit: 1,
    });
    expect(client.alertRule.create).not.toHaveBeenCalled();
  });

  it('PRO: sem limite', async () => {
    const { service, client } = makeService(Plan.PRO, 500);
    await service.createRule('u1', { kind: AlertKind.AUTHOR, value: 'ansem' });
    expect(client.alertRule.create).toHaveBeenCalled();
  });

  it('FREE com regras sobrando: só a mais antiga ativa é `effective`', async () => {
    const { service } = makeService(Plan.FREE, 2);
    const { items, limit } = await service.listRules('u1');
    expect(limit).toBe(1);
    expect(items.map((r) => [r.id, r.effective])).toEqual([
      ['old', true],
      ['new', false],
    ]);
  });

  it('push: recusa endpoint fora da allowlist (SSRF)', async () => {
    const { service } = makeService(Plan.PRO, 0);
    await expect(
      service.subscribePush('u1', {
        endpoint: 'https://169.254.169.254/latest',
        keys: { p256dh: 'x', auth: 'y' },
      }),
    ).rejects.toThrow(/Unsupported push endpoint/);
  });
});
