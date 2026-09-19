import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EntitlementsService } from '../billing/entitlements.service';

/**
 * Recorte do feed por plano — a ÚNICA regra, usada pelo REST (lista, detalhe,
 * grupos, autor, favoritos) e pelo socket (`feed:new`). Duas cópias da regra
 * divergiriam, e o socket é justamente o caminho que ninguém testa na mão.
 *
 * PRO vê tudo. FREE vê só capturas de monitores com `freeTier = true`. Captura
 * sem monitor (regra apagada, `monitorId` null) NÃO é gratuita: na dúvida, fecha.
 *
 * Os ids dos monitores gratuitos são lidos a cada chamada, sem cache: a tabela
 * tem dezenas de linhas (índice em `freeTier`) e assim a troca feita pelo admin
 * vale na requisição seguinte, sem invalidação para esquecer.
 */
@Injectable()
export class FeedAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /** Ids dos monitores liberados para o FREE. */
  async freeMonitorIds(): Promise<string[]> {
    const rows = await this.prisma.getReadClient().discordMonitor.findMany({
      where: { freeTier: true },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /**
   * `null` = sem recorte (PRO). Array = só estes monitores (FREE) — pode vir
   * vazio, e aí o FREE não vê nada até o admin liberar algum grupo.
   */
  async allowedMonitorIds(userId: string): Promise<string[] | null> {
    const { allGroups } = await this.entitlements.limitsFor(userId);
    return allGroups ? null : this.freeMonitorIds();
  }

  /** Filtro Prisma para somar ao `where` de qualquer leitura de capturas. */
  async whereFor(userId: string): Promise<Prisma.CapturedMessageWhereInput> {
    const ids = await this.allowedMonitorIds(userId);
    return ids === null ? {} : { monitorId: { in: ids } };
  }

  /** Mesmo recorte em SQL cru (para os `$queryRaw` de agregação). */
  async sqlFor(userId: string, alias = ''): Promise<Prisma.Sql> {
    const ids = await this.allowedMonitorIds(userId);
    if (ids === null) return Prisma.sql`TRUE`;
    if (ids.length === 0) return Prisma.sql`FALSE`;
    const col = Prisma.raw(alias ? `${alias}."monitorId"` : `"monitorId"`);
    return Prisma.sql`${col} IN (${Prisma.join(ids)})`;
  }
}
