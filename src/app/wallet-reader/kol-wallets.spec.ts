import { Plan } from '@prisma/client';
import { limitsFor } from '../billing/plan-limits';
import { KolIndexService } from './kol-index.service';

/**
 * Carteiras dos KOLs são recurso do PRO. O que estes testes travam:
 *  - FREE não recebe endereço por nenhuma porta de leitura (modal, busca);
 *  - o Salvar do modal do FREE (que manda `wallets: []`) NÃO vira "removeu
 *    todas as carteiras do preset" gravado na conta.
 */

const PRESET = {
  id: 'k1',
  name: 'Ansem',
  wallets: [{ name: 'main', address: 'So1AnsemWallet' }],
  squads: [],
  relevance: 50,
  types: [],
  twitter: '',
  notes: '',
  avatar: null,
  deletedAt: null,
};

function makeService(plan: Plan) {
  const upserts: any[] = [];
  const client = {
    kolPreset: {
      findFirst: jest.fn(async () => PRESET),
      findUnique: jest.fn(async () => PRESET),
      findMany: jest.fn(async () => [PRESET]),
      count: jest.fn(async () => 1),
    },
    kolUserOverride: {
      count: jest.fn(async () => 0),
      findUnique: jest.fn(async () => null),
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
      upsert: jest.fn(async (args: any) => {
        upserts.push(args);
        return {
          kolId: 'k1',
          isCustom: false,
          deleted: false,
          updatedAt: new Date(),
          ...args.update,
        };
      }),
    },
    walletScan: { findMany: jest.fn(async () => []) },
  };
  const service = new KolIndexService(
    { getReadClient: () => client, getWriteClient: () => client } as any,
    { limitsFor: async () => limitsFor(plan) } as any,
  );
  return { service, upserts };
}

describe('KOL index — carteiras por plano', () => {
  it('PRO: o modal recebe as carteiras', async () => {
    const { service } = makeService(Plan.PRO);
    const kol = await service.getOne('u1', 'k1');
    expect(kol.wallets).toHaveLength(1);
    expect(kol.walletsLocked).toBe(false);
  });

  it('FREE: o modal vem sem endereços, mas com a contagem', async () => {
    const { service } = makeService(Plan.FREE);
    const kol = await service.getOne('u1', 'k1');
    expect(kol.wallets).toEqual([]);
    expect(kol.walletCount).toBe(1);
    expect(kol.walletsLocked).toBe(true);
  });

  it('FREE: buscar pelo endereço não acha o KOL (sem oráculo)', async () => {
    const { service } = makeService(Plan.FREE);
    const page = await service.getIndex('u1', { search: 'so1ansem' });
    expect(page.total).toBe(0);
    expect(page.walletsLocked).toBe(true);
  });

  it('PRO: buscar pelo endereço acha o KOL', async () => {
    const { service } = makeService(Plan.PRO);
    const page = await service.getIndex('u1', { search: 'so1ansem' });
    expect(page.total).toBe(1);
  });

  it('FREE: Salvar com wallets=[] NÃO grava remoção das carteiras do preset', async () => {
    const { service, upserts } = makeService(Plan.FREE);
    await service.upsertOverride('u1', 'k1', {
      wallets: [],
      notes: 'hi',
    } as any);
    const { update } = upserts[0];
    expect(update.notes).toBe('hi');
    expect(update).not.toHaveProperty('walletsRemoved');
    expect(update).not.toHaveProperty('walletsAdded');
  });

  it('PRO: Salvar com wallets=[] grava a remoção (comportamento de sempre)', async () => {
    const { service, upserts } = makeService(Plan.PRO);
    await service.upsertOverride('u1', 'k1', { wallets: [] } as any);
    expect(upserts[0].update.walletsRemoved).toEqual(['So1AnsemWallet']);
  });
});
