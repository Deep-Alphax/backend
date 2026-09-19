import { Plan, Prisma } from '@prisma/client';
import { limitsFor } from '../billing/plan-limits';
import { FeedAccessService } from './feed-access.service';

function makeService(plan: Plan, freeIds: string[]) {
  const findMany = jest.fn(async () => freeIds.map((id) => ({ id })));
  const prisma: any = {
    getReadClient: () => ({ discordMonitor: { findMany } }),
  };
  const entitlements: any = { limitsFor: async () => limitsFor(plan) };
  return { service: new FeedAccessService(prisma, entitlements), findMany };
}

/** Renderiza o Prisma.Sql como o Postgres o receberia (texto + parâmetros). */
const render = (sql: Prisma.Sql) => ({ text: sql.sql, values: sql.values });

describe('FeedAccessService', () => {
  it('PRO: sem recorte, e nem consulta os grupos liberados', async () => {
    const { service, findMany } = makeService(Plan.PRO, ['m1']);
    expect(await service.whereFor('u')).toEqual({});
    expect(render(await service.sqlFor('u')).text).toBe('TRUE');
    expect(findMany).not.toHaveBeenCalled();
  });

  it('FREE: só os monitores liberados', async () => {
    const { service } = makeService(Plan.FREE, ['m1', 'm2']);
    expect(await service.whereFor('u')).toEqual({
      monitorId: { in: ['m1', 'm2'] },
    });
    const sql = render(await service.sqlFor('u', 'cm'));
    expect(sql.text).toBe('cm."monitorId" IN (?,?)');
    expect(sql.values).toEqual(['m1', 'm2']); // parametrizado, sem concatenação
  });

  it('FREE sem nenhum grupo liberado: não vê nada (fail-closed)', async () => {
    const { service } = makeService(Plan.FREE, []);
    expect(await service.whereFor('u')).toEqual({ monitorId: { in: [] } });
    expect(render(await service.sqlFor('u')).text).toBe('FALSE');
  });
});
