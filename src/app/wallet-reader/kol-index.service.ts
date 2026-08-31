import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import KOL_PROFILES from './data/kol-profiles.json';
import {
  CreateKolCustomDto,
  CreateKolPresetDto,
  ImportKolBackupDto,
  KolPresetQueryDto,
  KolQueryDto,
  UpdateKolOverrideDto,
  UpdateKolPresetDto,
} from './dto/kol.dto';

/**
 * Níveis ("Level") do KOL — espelho de `KOL_TIERS` no frontend
 * (`src/lib/walletReader/types.ts`). Os `id` e as faixas TÊM que bater com os de
 * lá: o filtro por tier chega como lista de `id` e as contagens da rail são
 * calculadas aqui (agregação é do backend).
 */
const TIERS = [
  { id: 'wood', min: 0, max: 12 },
  { id: 'bronze', min: 13, max: 25 },
  { id: 'silver', min: 26, max: 37 },
  { id: 'gold', min: 38, max: 50 },
  { id: 'platinum', min: 51, max: 62 },
  { id: 'diamond', min: 63, max: 75 },
  { id: 'alpha', min: 76, max: 87 },
  { id: 'super-alpha', min: 88, max: 100 },
] as const;

/** Piso do nível `alpha` — recorte rápido "Alpha e acima" da rail. */
const ALPHA_MIN = TIERS.find((t) => t.id === 'alpha')!.min;

const tierOf = (score: number) =>
  TIERS.find((t) => score >= t.min && score <= t.max)?.id ?? TIERS[0].id;

const DEFAULT_LIMIT = 60;

/** Lista "a,b,c" → Set. Vazio/ausente = faceta não filtra. */
const asSet = (v?: string): Set<string> =>
  new Set((v ?? '').split(',').map((x) => x.trim()).filter(Boolean));

export interface WalletRef {
  name: string;
  address: string;
}

/** Um KOL do preset global — o que TODO usuário enxerga. */
export interface KolPresetView {
  id: string;
  name: string;
  wallets: WalletRef[];
  squads: string[];
  relevance: number;
  types: string[];
  twitter: string;
  notes: string;
  avatar: string | null;
}

/** O que UM usuário mudou em UM KOL. `null` = herda o campo do preset. */
export interface KolOverrideView {
  kolId: string;
  name: string | null;
  relevance: number | null;
  types: string[] | null;
  fnfGroups: string[] | null;
  twitter: string | null;
  notes: string | null;
  avatar: string | null;
  walletsAdded: WalletRef[] | null;
  walletsRemoved: string[] | null;
  dismissedSidewallets: string[] | null;
  isCustom: boolean;
  deleted: boolean;
  updatedAt: number;
}

/**
 * Patch do override — só valores escalares, nunca operações do Prisma
 * (`{ set: … }`). Por isso serve tanto ao `create` quanto ao `update` do upsert.
 */
type OverridePatch = Partial<{
  name: string | null;
  relevance: number | null;
  twitter: string | null;
  notes: string | null;
  avatar: string | null;
  deleted: boolean;
  types: Prisma.InputJsonValue | Prisma.NullTypes.DbNull;
  fnfGroups: Prisma.InputJsonValue | Prisma.NullTypes.DbNull;
  walletsAdded: Prisma.InputJsonValue | Prisma.NullTypes.DbNull;
  walletsRemoved: Prisma.InputJsonValue | Prisma.NullTypes.DbNull;
  dismissedSidewallets: Prisma.InputJsonValue | Prisma.NullTypes.DbNull;
}>;

/** Estado EFETIVO de um KOL (preset + override), já mesclado no servidor. */
export interface KolStateView {
  id: string;
  name: string;
  wallets: WalletRef[];
  walletCount: number;
  squads: string[];
  seedRelevance: number;
  isCustom: boolean;
  relevance: number;
  types: string[];
  fnfGroups: string[];
  twitter: string;
  notes: string;
  avatar: string | null;
  dismissedSidewallets: string[];
}

/**
 * Item da LISTA: o estado efetivo sem a lista de carteiras.
 *
 * O card só mostra `walletCount`; carregar os endereços de 60 KOLs para exibir
 * um número era metade do payload. Quem precisa das carteiras é o modal, e ele
 * busca o KOL por `GET /kols/:kolId`.
 */
export type KolListItem = Omit<KolStateView, 'wallets'>;

/** Uma página do índice + tudo que a rail precisa, numa chamada. */
export interface KolIndexPage {
  items: KolListItem[];
  total: number;
  counts: {
    byTier: Record<string, number>;
    byType: Record<string, number>;
    bySquad: Record<string, number>;
    byGroup: Record<string, number>;
  };
  viewCounts: Record<string, number>;
  squads: string[];
  groups: KolGroupView[];
}

/** Linha da lista de admin: o preset sem os endereços, só a contagem. */
export type KolPresetListItem = Omit<KolPresetView, 'wallets'> & {
  walletCount: number;
  deletedAt: number | null;
};

export interface KolGroupView {
  id: string;
  name: string;
}

/** Tudo que a tela de KOLs precisa, em UMA chamada. */
export interface KolIndexView {
  preset: KolPresetView[];
  overrides: KolOverrideView[];
  groups: KolGroupView[];
}

interface SeedProfile {
  id: string;
  name: string;
  wallets: WalletRef[];
  squads?: string[];
  seedRelevance?: number;
}

/**
 * KOL Index em duas camadas.
 *
 * - `KolPreset` é global e só ADMIN escreve: é o "preset" que todo usuário vê.
 * - `KolUserOverride` é da conta: o usuário comum edita o KOL só para ele.
 *
 * O merge (preset + override) é feito no CLIENTE, não aqui: a tela já compunha
 * estado efetivo a partir de base + override, e mandar as duas camadas separadas
 * deixa o front distinguir "herdado" de "editado por mim" (para exibir o que foi
 * alterado e permitir voltar ao preset).
 */
@Injectable()
export class KolIndexService implements OnModuleInit {
  private readonly logger = new Logger(KolIndexService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Seed do preset a partir do JSON (1×, só se a tabela estiver vazia). */
  async onModuleInit(): Promise<void> {
    try {
      const count = await this.prisma.getReadClient().kolPreset.count();
      if (count > 0) return;
      const rows = KOL_PROFILES as unknown as SeedProfile[];
      if (!rows?.length) return;
      await this.prisma.getWriteClient().kolPreset.createMany({
        data: rows.map((p) => ({
          id: p.id,
          name: p.name,
          wallets: (p.wallets ?? []) as unknown as Prisma.InputJsonValue,
          squads: p.squads ?? [],
          relevance: p.seedRelevance ?? 20,
        })),
        skipDuplicates: true,
      });
      this.logger.log(`Seed de ${rows.length} KOLs no preset.`);
    } catch (e: any) {
      this.logger.warn(`Falha no seed do preset de KOLs: ${e?.message}`);
    }
  }

  // ── Leitura ────────────────────────────────────────────────────────────────

  /**
   * UMA página do índice, já mesclada, filtrada, contada e ordenada no servidor.
   *
   * O merge `preset + override` e as facetas rodam aqui porque mandar o índice
   * inteiro para o cliente filtrar não escala: eram 73 KB com 276 KOLs, linear
   * daí em diante, a cada carregamento e por usuário.
   */
  async getIndex(userId: string, q: KolQueryDto = {}): Promise<KolIndexPage> {
    const db = this.prisma.getReadClient();
    const [preset, overrides, groups, scanned] = await Promise.all([
      db.kolPreset.findMany({ where: { deletedAt: null } }),
      db.kolUserOverride.findMany({ where: { userId } }),
      db.kolUserGroup.findMany({ where: { userId }, orderBy: { name: 'asc' } }),
      db.walletScan.findMany({ select: { kolId: true } }),
    ]);

    const groupIds = new Set(groups.map((g) => g.id));
    const overrideBy = new Map(overrides.map((o) => [o.kolId, o]));
    const hidden = new Set(overrides.filter((o) => o.deleted).map((o) => o.kolId));
    const scannedIds = new Set(scanned.map((r) => r.kolId));

    const states: KolStateView[] = [];
    for (const p of preset) {
      if (hidden.has(p.id)) continue;
      states.push(this.mergeState(p.id, p, overrideBy.get(p.id), groupIds));
    }
    for (const o of overrides) {
      if (o.isCustom && !o.deleted) {
        states.push(this.mergeState(o.kolId, null, o, groupIds));
      }
    }

    // 1) recorte rápido + busca — a base das contagens de faceta.
    const term = (q.search ?? '').trim().toLowerCase();
    const inView = (st: KolStateView): boolean => {
      switch (q.view) {
        case 'unclassified':
          return st.types.length === 0;
        case 'alphaUp':
          // "Alpha e acima" = a partir do nível `alpha` (ver TIERS).
          return st.relevance >= ALPHA_MIN;
        case 'noTwitter':
          return !st.twitter;
        case 'pendingScan':
          return !scannedIds.has(st.id);
        default:
          return true;
      }
    };
    const base = states.filter((st) => {
      if (!inView(st)) return false;
      if (!term) return true;
      const hay = (
        st.name +
        ' ' +
        st.wallets.map((w) => `${w.name} ${w.address}`).join(' ')
      ).toLowerCase();
      return hay.includes(term);
    });

    const counts = {
      byTier: {} as Record<string, number>,
      byType: {} as Record<string, number>,
      bySquad: {} as Record<string, number>,
      byGroup: {} as Record<string, number>,
    };
    const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);
    for (const st of base) {
      bump(counts.byTier, tierOf(st.relevance));
      st.types.forEach((t) => bump(counts.byType, t));
      st.squads.forEach((x) => bump(counts.bySquad, x));
      st.fnfGroups.forEach((g) => bump(counts.byGroup, g));
    }

    const viewCounts: Record<string, number> = {
      all: states.length,
      unclassified: states.filter((st) => st.types.length === 0).length,
      alphaUp: states.filter((st) => st.relevance >= ALPHA_MIN).length,
      noTwitter: states.filter((st) => !st.twitter).length,
      pendingScan: states.filter((st) => !scannedIds.has(st.id)).length,
    };

    // 2) facetas marcadas.
    const tiers = asSet(q.tiers);
    const types = asSet(q.types);
    const squadsF = asSet(q.squads);
    const groupsF = asSet(q.groups);
    const filtered = base.filter((st) => {
      if (tiers.size && !tiers.has(tierOf(st.relevance))) return false;
      if (types.size && !st.types.some((t) => types.has(t))) return false;
      if (squadsF.size && !st.squads.some((x) => squadsF.has(x))) return false;
      if (groupsF.size && !st.fnfGroups.some((g) => groupsF.has(g))) return false;
      return true;
    });

    // 3) ordenação e recorte da página.
    const rank = (st: KolStateView) => TIERS.findIndex((t) => t.id === tierOf(st.relevance));
    switch (q.sort) {
      case 'name':
        filtered.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'wallets':
        filtered.sort((a, b) => b.walletCount - a.walletCount);
        break;
      case 'tier':
        filtered.sort((a, b) => rank(b) - rank(a) || b.relevance - a.relevance);
        break;
      default:
        filtered.sort((a, b) => b.relevance - a.relevance);
    }

    const offset = q.offset ?? 0;
    const limit = q.limit ?? DEFAULT_LIMIT;
    return {
      items: filtered.slice(offset, offset + limit).map(({ wallets: _w, ...rest }) => rest),
      total: filtered.length,
      counts,
      viewCounts,
      squads: Array.from(new Set(preset.flatMap((p) => p.squads))).sort(),
      groups: groups.map((g) => ({ id: g.id, name: g.name })),
    };
  }

  /** Estado EFETIVO de UM KOL — o modal abre por aqui. */
  async getOne(userId: string, kolId: string): Promise<KolStateView> {
    const db = this.prisma.getReadClient();
    const [preset, override, groups] = await Promise.all([
      db.kolPreset.findFirst({ where: { id: kolId, deletedAt: null } }),
      db.kolUserOverride.findUnique({ where: { userId_kolId: { userId, kolId } } }),
      db.kolUserGroup.findMany({ where: { userId }, select: { id: true } }),
    ]);
    if (!preset && !override) throw new NotFoundException('KOL não encontrado');
    return this.mergeState(
      kolId,
      preset,
      override,
      new Set(groups.map((g) => g.id)),
    );
  }

  /**
   * Merge campo a campo: o override vence, `null` herda. Só o `avatar` tem um
   * terceiro estado — `""` quer dizer "o usuário limpou a foto do preset".
   */
  private mergeState(
    kolId: string,
    p: {
      name: string;
      wallets: Prisma.JsonValue;
      squads: string[];
      relevance: number;
      types: string[];
      twitter: string;
      notes: string;
      avatar: string | null;
    } | null,
    o: {
      name: string | null;
      relevance: number | null;
      types: Prisma.JsonValue | null;
      fnfGroups: Prisma.JsonValue | null;
      twitter: string | null;
      notes: string | null;
      avatar: string | null;
      walletsAdded: Prisma.JsonValue | null;
      walletsRemoved: Prisma.JsonValue | null;
      dismissedSidewallets: Prisma.JsonValue | null;
      isCustom: boolean;
    } | null | undefined,
    knownGroups: Set<string>,
  ): KolStateView {
    const presetWallets = this.asWalletArray(p?.wallets ?? null) ?? [];
    const removed = new Set(this.asStringArray(o?.walletsRemoved ?? null) ?? []);
    const wallets = presetWallets
      .filter((w) => !removed.has(w.address))
      .concat(this.asWalletArray(o?.walletsAdded ?? null) ?? []);

    return {
      id: kolId,
      name: o?.name?.trim() || p?.name || 'Sem nome',
      wallets,
      walletCount: wallets.length,
      squads: p?.squads ?? [],
      seedRelevance: p?.relevance ?? 20,
      isCustom: !p,
      relevance: o?.relevance ?? p?.relevance ?? 20,
      types: this.asStringArray(o?.types ?? null) ?? p?.types ?? [],
      fnfGroups: (this.asStringArray(o?.fnfGroups ?? null) ?? []).filter((g) =>
        knownGroups.has(g),
      ),
      twitter: o?.twitter ?? p?.twitter ?? '',
      notes: o?.notes ?? p?.notes ?? '',
      avatar: o?.avatar === '' ? null : (o?.avatar ?? p?.avatar ?? null),
      dismissedSidewallets: this.asStringArray(o?.dismissedSidewallets ?? null) ?? [],
    };
  }

  // ── Override do usuário ────────────────────────────────────────────────────

  /** Cria/atualiza o override do usuário para um KOL. */
  async upsertOverride(
    userId: string,
    kolId: string,
    dto: UpdateKolOverrideDto,
  ): Promise<KolOverrideView> {
    // Só aceita KOL que exista no preset ou que já seja custom DESTE usuário —
    // sem isso, qualquer id inventado viraria linha no banco.
    const known = await this.isKnownKol(userId, kolId);
    if (!known) throw new NotFoundException('KOL não encontrado');

    const data = this.overrideData(dto);

    // `wallets` chega como a lista EFETIVA desejada; o diff contra o preset é
    // responsabilidade daqui — o cliente não precisa conhecer a camada base.
    if (dto.wallets) {
      const preset = await this.prisma
        .getReadClient()
        .kolPreset.findUnique({ where: { id: kolId }, select: { wallets: true } });
      const base = this.asWalletArray(preset?.wallets ?? null) ?? [];
      const wanted = dto.wallets;
      data.walletsRemoved = base
        .filter((b) => !wanted.some((w) => w.address === b.address))
        .map((b) => b.address) as unknown as Prisma.InputJsonValue;
      data.walletsAdded = wanted.filter(
        (w) => !base.some((b) => b.address === w.address),
      ) as unknown as Prisma.InputJsonValue;
    }
    const row = await this.prisma.getWriteClient().kolUserOverride.upsert({
      where: { userId_kolId: { userId, kolId } },
      create: { userId, kolId, ...data },
      update: data,
    });
    return this.toOverrideView(row);
  }

  /** Descarta as edições do usuário — o KOL volta ao preset. */
  async deleteOverride(userId: string, kolId: string): Promise<{ ok: true }> {
    await this.prisma
      .getWriteClient()
      .kolUserOverride.deleteMany({ where: { userId, kolId } });
    return { ok: true };
  }

  /** Cria um KOL que existe só na conta do usuário. */
  async createCustom(
    userId: string,
    dto: CreateKolCustomDto,
  ): Promise<KolOverrideView> {
    const kolId = `custom-${randomBytes(6).toString('hex')}`;
    const row = await this.prisma.getWriteClient().kolUserOverride.create({
      data: {
        userId,
        kolId,
        isCustom: true,
        name: dto.name,
        relevance: 20,
        types: [] as unknown as Prisma.InputJsonValue,
        walletsAdded: (dto.wallet ? [dto.wallet] : []) as unknown as Prisma.InputJsonValue,
      },
    });
    return this.toOverrideView(row);
  }

  /** Apaga TODAS as edições da conta — os KOLs voltam ao preset puro. */
  async resetAll(userId: string): Promise<{ ok: true }> {
    const db = this.prisma.getWriteClient();
    await db.$transaction([
      db.kolUserOverride.deleteMany({ where: { userId } }),
      db.kolUserGroup.deleteMany({ where: { userId } }),
    ]);
    return { ok: true };
  }

  /**
   * Restaura um backup NA CONTA, numa chamada só (o front não dispara N
   * requests). Grupos são recriados por nome e `fnfGroups` é remapeado para os
   * ids desta conta. Um `kolId` desconhecido entra como KOL custom — é como um
   * KOL criado pelo usuário chega no arquivo.
   */
  async importBackup(
    userId: string,
    dto: ImportKolBackupDto,
  ): Promise<{ imported: number; groups: KolGroupView[] }> {
    // 1) Grupos: id do arquivo → id desta conta.
    const idMap = new Map<string, string>();
    for (const g of dto.groups ?? []) {
      const created = await this.createGroup(userId, g.name);
      idMap.set(g.id, created.id);
    }

    // 2) Overrides, com as referências de grupo já traduzidas.
    const db = this.prisma.getWriteClient();
    const presetIds = new Set(
      (await db.kolPreset.findMany({ select: { id: true } })).map((p) => p.id),
    );

    let imported = 0;
    for (const { kolId, ...patch } of dto.overrides ?? []) {
      if (patch.fnfGroups) {
        patch.fnfGroups = patch.fnfGroups
          .map((g) => idMap.get(g) ?? g)
          .filter((g) => [...idMap.values()].includes(g));
      }
      const data = this.overrideData(patch);
      const isCustom = !presetIds.has(kolId);
      await db.kolUserOverride.upsert({
        where: { userId_kolId: { userId, kolId } },
        create: { userId, kolId, isCustom, ...data },
        update: data,
      });
      imported++;
    }

    const groups = await db.kolUserGroup.findMany({
      where: { userId },
      orderBy: { name: 'asc' },
    });
    return { imported, groups: groups.map((g) => ({ id: g.id, name: g.name })) };
  }

  // ── Grupos / FnFs do usuário ───────────────────────────────────────────────

  /** Cria o grupo — ou devolve o existente de mesmo nome (idempotente). */
  async createGroup(userId: string, name: string): Promise<KolGroupView> {
    const db = this.prisma.getWriteClient();
    const existing = await db.kolUserGroup.findFirst({
      where: { userId, name: { equals: name, mode: 'insensitive' } },
    });
    if (existing) return { id: existing.id, name: existing.name };
    const row = await db.kolUserGroup.create({ data: { userId, name } });
    return { id: row.id, name: row.name };
  }

  async renameGroup(userId: string, id: string, name: string): Promise<KolGroupView> {
    const { count } = await this.prisma
      .getWriteClient()
      .kolUserGroup.updateMany({ where: { id, userId }, data: { name } });
    if (!count) throw new NotFoundException('Grupo não encontrado');
    return { id, name };
  }

  /** Remove o grupo E a referência a ele nos overrides do MESMO usuário. */
  async deleteGroup(userId: string, id: string): Promise<{ ok: true }> {
    const db = this.prisma.getWriteClient();
    const { count } = await db.kolUserGroup.deleteMany({ where: { id, userId } });
    if (!count) throw new NotFoundException('Grupo não encontrado');

    // Filtra em memória: o volume por conta é pequeno e um filtro de Json nulo
    // no Prisma exigiria `{ not: DbNull }`, que não cobre o caso "não é array".
    const affected = await db.kolUserOverride.findMany({
      where: { userId },
      select: { id: true, fnfGroups: true },
    });
    await Promise.all(
      affected
        .map((o) => ({ id: o.id, groups: this.asStringArray(o.fnfGroups) }))
        .filter((o) => o.groups?.includes(id))
        .map((o) =>
          db.kolUserOverride.update({
            where: { id: o.id },
            data: {
              fnfGroups: (o.groups ?? []).filter(
                (g) => g !== id,
              ) as unknown as Prisma.InputJsonValue,
            },
          }),
        ),
    );
    return { ok: true };
  }

  /**
   * Backup da conta. Virou endpoint porque o cliente não carrega mais todos os
   * overrides — ele só recebe a página que está vendo.
   */
  async exportBackup(userId: string): Promise<{
    version: 1;
    exportedAt: string;
    overrides: Record<string, unknown>;
    customIds: string[];
    groups: KolGroupView[];
  }> {
    const db = this.prisma.getReadClient();
    const [rows, groups] = await Promise.all([
      db.kolUserOverride.findMany({ where: { userId } }),
      db.kolUserGroup.findMany({ where: { userId }, orderBy: { name: 'asc' } }),
    ]);
    const overrides: Record<string, unknown> = {};
    for (const r of rows) {
      const { kolId, name, relevance, types, fnfGroups, twitter, notes, avatar } = r;
      overrides[kolId] = {
        name,
        relevance,
        types,
        fnfGroups,
        twitter,
        notes,
        avatar,
        walletsAdded: r.walletsAdded,
        walletsRemoved: r.walletsRemoved,
        dismissedSidewallets: r.dismissedSidewallets,
        deleted: r.deleted,
      };
    }
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      overrides,
      customIds: rows.filter((r) => r.isCustom).map((r) => r.kolId),
      groups: groups.map((g) => ({ id: g.id, name: g.name })),
    };
  }

  // ── Preset (ADMIN) ─────────────────────────────────────────────────────────

  /**
   * Preset paginado e buscado NO BANCO, incluindo os excluídos (a tela de admin
   * mostra os dois). Antes devolvia a tabela inteira — 77 KB e crescendo.
   *
   * A busca por NOME usa `ILIKE`, que é o que o índice GIN/`gin_trgm_ops` de
   * `KolPreset.name` acelera. Endereço mora numa coluna JSON e não tem índice:
   * por isso só entra na busca quando o termo tem cara de endereço, via um
   * pré-filtro de ids — assim uma busca por nome não paga a varredura do JSON.
   */
  async listPreset(
    q: KolPresetQueryDto = {},
  ): Promise<{ items: KolPresetListItem[]; total: number }> {
    const db = this.prisma.getReadClient();
    const term = (q.search ?? '').trim();

    let where: Prisma.KolPresetWhereInput = {};
    if (term) {
      const or: Prisma.KolPresetWhereInput[] = [
        { name: { contains: term, mode: 'insensitive' } },
        { squads: { has: term } },
      ];
      // Base58 e longo o bastante = provável endereço on-chain.
      if (/^[1-9A-HJ-NP-Za-km-z]{24,}$/.test(term)) {
        const hits = await db.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT id FROM "KolPreset" WHERE wallets::text ILIKE ${'%' + term + '%'} LIMIT 500`,
        );
        if (hits.length) or.push({ id: { in: hits.map((h) => h.id) } });
      }
      where = { OR: or };
    }

    const [rows, total] = await Promise.all([
      db.kolPreset.findMany({
        where,
        orderBy: [{ relevance: 'desc' }, { name: 'asc' }],
        skip: q.offset ?? 0,
        take: q.limit ?? DEFAULT_LIMIT,
      }),
      db.kolPreset.count({ where }),
    ]);

    return {
      // Sem a lista de carteiras: a linha só mostra a contagem. Quem precisa dos
      // endereços é o editor, e ele busca por `GET /admin/kols/:id`.
      items: rows.map((r) => {
        const { wallets: _w, ...view } = this.toPresetView(r);
        return {
          ...view,
          walletCount: this.asWalletArray(r.wallets)?.length ?? 0,
          deletedAt: r.deletedAt ? r.deletedAt.getTime() : null,
        };
      }),
      total,
    };
  }

  /** Um KOL do preset, COM as carteiras — o editor do admin abre por aqui. */
  async getPreset(id: string): Promise<KolPresetView & { deletedAt: number | null }> {
    const row = await this.prisma.getReadClient().kolPreset.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('KOL não encontrado no preset');
    return {
      ...this.toPresetView(row),
      deletedAt: row.deletedAt ? row.deletedAt.getTime() : null,
    };
  }

  async createPreset(dto: CreateKolPresetDto): Promise<KolPresetView> {
    const row = await this.prisma.getWriteClient().kolPreset.create({
      data: {
        id: randomBytes(5).toString('hex'),
        name: dto.name,
        wallets: (dto.wallets ?? []) as unknown as Prisma.InputJsonValue,
        squads: dto.squads ?? [],
        relevance: dto.relevance ?? 20,
        types: dto.types ?? [],
        twitter: dto.twitter ?? '',
        notes: dto.notes ?? '',
        avatar: dto.avatar ?? null,
      },
    });
    return this.toPresetView(row);
  }

  async updatePreset(id: string, dto: UpdateKolPresetDto): Promise<KolPresetView> {
    const data: Prisma.KolPresetUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name ?? '';
    if (dto.wallets !== undefined) {
      data.wallets = dto.wallets as unknown as Prisma.InputJsonValue;
    }
    if (dto.squads !== undefined) data.squads = dto.squads;
    if (dto.relevance !== undefined) data.relevance = dto.relevance ?? 20;
    if (dto.types !== undefined) data.types = dto.types ?? [];
    if (dto.twitter !== undefined) data.twitter = dto.twitter ?? '';
    if (dto.notes !== undefined) data.notes = dto.notes ?? '';
    // `avatar: null` no preset significa "sem avatar" (não há camada acima).
    if (dto.avatar !== undefined) data.avatar = dto.avatar;

    try {
      const row = await this.prisma
        .getWriteClient()
        .kolPreset.update({ where: { id }, data });
      return this.toPresetView(row);
    } catch {
      throw new NotFoundException('KOL não encontrado no preset');
    }
  }

  /** Exclusão SOFT — overrides e scans referenciam o id sem FK. */
  async removePreset(id: string): Promise<{ ok: true }> {
    const { count } = await this.prisma
      .getWriteClient()
      .kolPreset.updateMany({ where: { id, deletedAt: null }, data: { deletedAt: new Date() } });
    if (!count) throw new NotFoundException('KOL não encontrado no preset');
    return { ok: true };
  }

  async restorePreset(id: string): Promise<{ ok: true }> {
    const { count } = await this.prisma
      .getWriteClient()
      .kolPreset.updateMany({ where: { id }, data: { deletedAt: null } });
    if (!count) throw new NotFoundException('KOL não encontrado no preset');
    return { ok: true };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** O id existe no preset OU já é um custom deste usuário? */
  private async isKnownKol(userId: string, kolId: string): Promise<boolean> {
    const db = this.prisma.getReadClient();
    const [preset, own] = await Promise.all([
      db.kolPreset.count({ where: { id: kolId, deletedAt: null } }),
      db.kolUserOverride.count({ where: { userId, kolId } }),
    ]);
    return preset > 0 || own > 0;
  }

  /**
   * Monta o `data` do upsert respeitando a convenção do PATCH: chave ausente
   * (`undefined`) não entra; `null` vira NULL no banco (volta a herdar).
   */
  private overrideData(dto: UpdateKolOverrideDto): OverridePatch {
    const data: OverridePatch = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.relevance !== undefined) data.relevance = dto.relevance;
    if (dto.twitter !== undefined) data.twitter = dto.twitter;
    if (dto.notes !== undefined) data.notes = dto.notes;
    if (dto.avatar !== undefined) data.avatar = dto.avatar;
    if (dto.deleted !== undefined) data.deleted = dto.deleted;
    if (dto.types !== undefined) data.types = this.json(dto.types);
    if (dto.fnfGroups !== undefined) data.fnfGroups = this.json(dto.fnfGroups);
    if (dto.walletsAdded !== undefined) data.walletsAdded = this.json(dto.walletsAdded);
    if (dto.walletsRemoved !== undefined) data.walletsRemoved = this.json(dto.walletsRemoved);
    if (dto.dismissedSidewallets !== undefined) {
      data.dismissedSidewallets = this.json(dto.dismissedSidewallets);
    }
    return data;
  }

  /** `null` em coluna Json precisa ser `DbNull` (NULL do SQL), não JSON `null`. */
  private json(v: unknown): Prisma.InputJsonValue | Prisma.NullTypes.DbNull {
    return v === null ? Prisma.DbNull : (v as Prisma.InputJsonValue);
  }

  private asStringArray(v: Prisma.JsonValue | null): string[] | null {
    return Array.isArray(v) ? (v as string[]) : null;
  }

  private asWalletArray(v: Prisma.JsonValue | null): WalletRef[] | null {
    return Array.isArray(v) ? (v as unknown as WalletRef[]) : null;
  }

  private toPresetView(r: {
    id: string;
    name: string;
    wallets: Prisma.JsonValue;
    squads: string[];
    relevance: number;
    types: string[];
    twitter: string;
    notes: string;
    avatar: string | null;
  }): KolPresetView {
    return {
      id: r.id,
      name: r.name,
      wallets: this.asWalletArray(r.wallets) ?? [],
      squads: r.squads,
      relevance: r.relevance,
      types: r.types,
      twitter: r.twitter,
      notes: r.notes,
      avatar: r.avatar,
    };
  }

  private toOverrideView(r: {
    kolId: string;
    name: string | null;
    relevance: number | null;
    types: Prisma.JsonValue | null;
    fnfGroups: Prisma.JsonValue | null;
    twitter: string | null;
    notes: string | null;
    avatar: string | null;
    walletsAdded: Prisma.JsonValue | null;
    walletsRemoved: Prisma.JsonValue | null;
    dismissedSidewallets: Prisma.JsonValue | null;
    isCustom: boolean;
    deleted: boolean;
    updatedAt: Date;
  }): KolOverrideView {
    return {
      kolId: r.kolId,
      name: r.name,
      relevance: r.relevance,
      types: this.asStringArray(r.types),
      fnfGroups: this.asStringArray(r.fnfGroups),
      twitter: r.twitter,
      notes: r.notes,
      avatar: r.avatar,
      walletsAdded: this.asWalletArray(r.walletsAdded),
      walletsRemoved: this.asStringArray(r.walletsRemoved),
      dismissedSidewallets: this.asStringArray(r.dismissedSidewallets),
      isCustom: r.isCustom,
      deleted: r.deleted,
      updatedAt: r.updatedAt.getTime(),
    };
  }
}
