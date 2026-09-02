import { KolIndexService } from './kol-index.service';

/**
 * Squads — a unificação de "squad do preset" com "grupo/FnF da conta".
 *
 * O que estes testes travam:
 *  - o estado efetivo é a UNIÃO das duas fontes, sem repetir e sem perder de
 *    vista quais são da conta (só esses o usuário pode tirar);
 *  - renomear/apagar mexem SÓ nos squads da conta — o do preset é global e um
 *    usuário não pode reescrever o de todo mundo por aqui.
 */

type OverrideRow = { id: string; squads: unknown };

/** PrismaService de mentira: só o que o serviço toca nestes caminhos. */
function makePrisma(rows: OverrideRow[]) {
  const updates: { id: string; squads: string[] }[] = [];
  const client = {
    kolUserOverride: {
      findMany: jest.fn(async () => rows),
      update: jest.fn(async ({ where, data }: any) => {
        updates.push({ id: where.id, squads: data.squads });
        return {};
      }),
    },
  };
  return {
    updates,
    service: new KolIndexService({
      getReadClient: () => client,
      getWriteClient: () => client,
    } as any),
  };
}

/** `mergeState` é privado — o comportamento é público via `getOne`/`getIndex`. */
function merge(preset: string[] | null, own: unknown) {
  const { service } = makePrisma([]);
  return (service as any).mergeState(
    'k1',
    preset === null
      ? null
      : {
          name: 'Ansem',
          wallets: [],
          squads: preset,
          relevance: 50,
          types: [],
          twitter: '',
          notes: '',
          avatar: null,
        },
    {
      name: null,
      relevance: null,
      types: null,
      squads: own,
      twitter: null,
      notes: null,
      avatar: null,
      walletsAdded: null,
      walletsRemoved: null,
      dismissedSidewallets: null,
      isCustom: false,
    },
  );
}

describe('estado efetivo dos squads', () => {
  it('soma os do preset com os da conta, nessa ordem', () => {
    const st = merge(['Lair'], ['Meu Squad']);
    expect(st.squads).toEqual(['Lair', 'Meu Squad']);
    expect(st.ownSquads).toEqual(['Meu Squad']);
  });

  it('não repete o mesmo squad vindo das duas fontes', () => {
    // A grafia do PRESET prevalece: é a que todo mundo vê.
    const st = merge(['Lair'], ['lair ', 'Outro']);
    expect(st.squads).toEqual(['Lair', 'Outro']);
  });

  it('apara espaços e descarta nome vazio', () => {
    expect(merge([' Lair '], ['', '   ', 'Outro']).squads).toEqual([
      'Lair',
      'Outro',
    ]);
  });

  it('override sem squads herda só os do preset', () => {
    const st = merge(['Lair'], null);
    expect(st.squads).toEqual(['Lair']);
    expect(st.ownSquads).toEqual([]);
  });

  it('KOL custom (fora do preset) fica só com os squads da conta', () => {
    const st = merge(null, ['Meu Squad']);
    expect(st.squads).toEqual(['Meu Squad']);
    expect(st.ownSquads).toEqual(['Meu Squad']);
  });

  it('valor torto na coluna Json não derruba a leitura', () => {
    expect(merge(['Lair'], 'não é array').squads).toEqual(['Lair']);
  });
});

describe('renameSquad', () => {
  it('renomeia em todos os KOLs da conta, ignorando caixa', () => {
    const { service, updates } = makePrisma([
      { id: 'o1', squads: ['Lair', 'Outro'] },
      { id: 'o2', squads: ['lair'] },
      { id: 'o3', squads: ['Nada a ver'] },
    ]);

    return service.renameSquad('u1', 'LAIR', 'Lair Alpha').then((res) => {
      expect(res).toEqual({ updated: 2 });
      expect(updates).toEqual([
        { id: 'o1', squads: ['Lair Alpha', 'Outro'] },
        { id: 'o2', squads: ['Lair Alpha'] },
      ]);
    });
  });

  it('renomear para um nome que o KOL já tem não duplica', async () => {
    const { service, updates } = makePrisma([
      { id: 'o1', squads: ['Lair', 'Alpha'] },
    ]);
    await service.renameSquad('u1', 'Lair', 'alpha');
    expect(updates).toEqual([{ id: 'o1', squads: ['alpha'] }]);
  });

  it('não escreve nada quando nenhum KOL usa o squad', async () => {
    const { service, updates } = makePrisma([{ id: 'o1', squads: ['Outro'] }]);
    const res = await service.renameSquad('u1', 'Lair', 'Novo');
    expect(res).toEqual({ updated: 0 });
    expect(updates).toEqual([]);
  });

  it('recusa nome de destino vazio', async () => {
    const { service } = makePrisma([{ id: 'o1', squads: ['Lair'] }]);
    await expect(service.renameSquad('u1', 'Lair', '   ')).rejects.toThrow();
  });
});

describe('deleteSquad', () => {
  it('tira o squad de todos os KOLs da conta', async () => {
    const { service, updates } = makePrisma([
      { id: 'o1', squads: ['Lair', 'Outro'] },
      { id: 'o2', squads: ['LAIR'] },
      { id: 'o3', squads: null },
    ]);

    const res = await service.deleteSquad('u1', 'lair');
    expect(res).toEqual({ updated: 2 });
    expect(updates).toEqual([
      { id: 'o1', squads: ['Outro'] },
      { id: 'o2', squads: [] },
    ]);
  });

  it('squad inexistente não gera escrita', async () => {
    const { service, updates } = makePrisma([{ id: 'o1', squads: ['Outro'] }]);
    expect(await service.deleteSquad('u1', 'Lair')).toEqual({ updated: 0 });
    expect(updates).toEqual([]);
  });
});
