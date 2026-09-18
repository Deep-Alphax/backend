import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import {
  DEFAULT_LEVEL1_BPS,
  DEFAULT_LEVEL2_BPS,
  MAX_RATE_BPS,
  affiliateChain,
  resolveRateBps,
  type AffiliateRates,
  canAttributeReferral,
  commissionCents,
  generateReferralCode,
  normalizeReferralCode,
  referralCodeError,
  referralLink,
  sumEarnings,
} from './commission';

/**
 * Uma linha da tabela "History": UM INDICADO, com os totais dele.
 *
 * O extrato é agregado por pessoa, não por fatura, porque é assim que a tela
 * pergunta ("quanto este usuário gastou, quanto me rendeu, desde quando, quando
 * foi a última vez"). As faturas continuam existindo uma a uma no banco — só a
 * leitura é que soma.
 */
export interface AffiliateHistoryRow {
  id: string;
  /** Quem foi indicado — só o primeiro nome ou o e-mail mascarado. */
  referredName: string;
  /** Tudo que este indicado já pagou, em centavos. */
  spentCents: number;
  /** Tudo que este indicado já rendeu ao afiliado, em centavos. */
  commissionCents: number;
  currency: string;
  /** Quando a conta foi criada (entrou pelo link). */
  startDate: Date;
  /** Última fatura paga por ele; null se nunca pagou. */
  lastSeenAt: Date | null;
}

export interface AffiliateOverview {
  code: string;
  link: string;
  /** Percentuais EFETIVOS deste afiliado (exceção negociada ou padrão). */
  level1Bps: number;
  level2Bps: number;
  currency: string;
  /** Apurado e ainda não repassado — "Available earnings". */
  availableCents: number;
  /** Tudo que o afiliado já gerou — "Total Earnings". */
  totalCents: number;
  /**
   * Receita bruta que os indicados trouxeram (o que ELES pagaram). O chip do
   * design chama isso de "Deposit": não existe depósito num produto de
   * assinatura, e este é o dinheiro que de fato entrou por causa do afiliado.
   */
  depositCents: number;
  /** Parte da comissão já repassada (status PAID) — chip "Spent". */
  paidOutCents: number;
  /** Quantas contas se cadastraram com o código — chip "Referalls". */
  referralCount: number;
  /** Quantas dessas contas já geraram ao menos uma comissão. */
  convertedCount: number;
  history: AffiliateHistoryRow[];
}

/** Quantas linhas do extrato a tela carrega de uma vez. */
const HISTORY_LIMIT = 50;

/** Quantos afiliados a tela do admin lista de uma vez. */
const ADMIN_LIST_LIMIT = 200;

/** Id da linha única de configuração. */
const SETTINGS_ID = 'default';

/** Uma linha da tabela de afiliados do admin. */
export interface AdminAffiliateRow {
  id: string;
  name: string;
  email: string;
  referralCode: string;
  /** Exceção negociada; null = usa o padrão global. */
  level1Bps: number | null;
  level2Bps: number | null;
  referralCount: number;
  totalEarnedCents: number;
}

/**
 * Programa de afiliados: 20% recorrente sobre cada fatura paga de um indicado,
 * enquanto ele for PRO.
 *
 * O repasse acontece POR FORA (Pix/transferência) — este módulo só apura e
 * registra. É por isso que não há nada de Stripe Connect aqui: `PENDING` vira
 * `PAID` quando o financeiro confirma, não quando um webhook chega.
 */
@Injectable()
export class AffiliatesService {
  private readonly logger = new Logger(AffiliatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  private appUrl(): string {
    return (
      this.configService.get<string>('FRONTEND_URL') ?? 'http://localhost:3000'
    );
  }

  /**
   * Resolve o código usado no cadastro para o id do afiliado.
   *
   * Devolve `null` em silêncio para código inexistente: um cadastro NÃO pode
   * falhar porque alguém digitou o link errado — o pior caso aceitável é a
   * venda não ser atribuída.
   */
  async resolveReferrer(
    rawCode: string | undefined | null,
  ): Promise<string | null> {
    if (!rawCode) return null;
    const code = normalizeReferralCode(rawCode);
    if (referralCodeError(code)) return null;

    const affiliate = await this.prisma.getReadClient().user.findUnique({
      where: { referralCode: code },
      select: { id: true, deletedAt: true, isActive: true },
    });
    if (!affiliate || affiliate.deletedAt || !affiliate.isActive) return null;
    return affiliate.id;
  }

  /**
   * Código do usuário, criando um na primeira vez.
   *
   * O retry existe porque `referralCode` é `@unique`: duas contas abrindo o
   * painel no mesmo instante podem sortear o mesmo código, e aí a segunda
   * sorteia de novo em vez de estourar na cara do usuário.
   */
  async ensureCode(userId: string): Promise<string> {
    const current = await this.prisma.getReadClient().user.findUnique({
      where: { id: userId },
      select: { referralCode: true },
    });
    if (current?.referralCode) return current.referralCode;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = generateReferralCode();
      try {
        await this.prisma.getWriteClient().user.update({
          where: { id: userId },
          data: { referralCode: code },
        });
        return code;
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          continue; // colisão — sorteia outro
        }
        throw err;
      }
    }
    throw new ConflictException('Could not generate a referral code.');
  }

  /** Troca o código (o botão "Edit" do painel). */
  async updateCode(userId: string, rawCode: string): Promise<string> {
    const error = referralCodeError(rawCode);
    if (error) throw new BadRequestException(error);

    const code = normalizeReferralCode(rawCode);
    try {
      await this.prisma.getWriteClient().user.update({
        where: { id: userId },
        data: { referralCode: code },
      });
      return code;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException('This code is already taken.');
      }
      throw err;
    }
  }

  /**
   * Painel do afiliado.
   *
   * Usa o cliente de ESCRITA (master), como o billing: o extrato é dinheiro e
   * o usuário costuma abrir a tela logo depois de uma cobrança — pelo lag da
   * réplica o saldo apareceria menor do que já é.
   */
  async getOverview(userId: string): Promise<AffiliateOverview> {
    const code = await this.ensureCode(userId);
    const db = this.prisma.getWriteClient();

    // Percentuais que valem para ESTE afiliado — a exceção negociada dele,
    // ou o padrão global. É o que a tela mostra como "Commission".
    const [defaults, override] = await Promise.all([
      this.getSettings(),
      this.overrideFor(userId),
    ]);

    // Duas consultas independentes, em paralelo: nenhuma depende da outra, e
    // serializar aqui só somaria latência.
    const [commissions, referrals] = await Promise.all([
      // Todas as comissões deste afiliado. O volume é limitado pelo número de
      // indicados × meses de assinatura, então somar em memória é barato — e
      // evita três GROUP BY separados para responder a mesma tela.
      db.referralCommission.findMany({
        where: { affiliateId: userId },
        orderBy: { createdAt: 'desc' },
        select: {
          referredUserId: true,
          paidAmountCents: true,
          amountCents: true,
          currency: true,
          status: true,
          createdAt: true,
        },
      }),
      // Os indicados, inclusive quem ainda não pagou nada: a tabela do design
      // lista PESSOAS, e quem entrou pelo link mas não assinou também conta.
      db.user.findMany({
        where: { referredById: userId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: HISTORY_LIMIT,
        select: { id: true, firstName: true, email: true, createdAt: true },
      }),
    ]);

    const { availableCents, totalCents } = sumEarnings(commissions);

    // Agrega por pessoa numa passada só.
    const byUser = new Map<
      string,
      { spentCents: number; commissionCents: number; lastSeenAt: Date | null }
    >();
    let depositCents = 0;
    let paidOutCents = 0;
    for (const c of commissions) {
      depositCents += c.paidAmountCents;
      if (c.status === 'PAID') paidOutCents += c.amountCents;

      const acc = byUser.get(c.referredUserId) ?? {
        spentCents: 0,
        commissionCents: 0,
        lastSeenAt: null as Date | null,
      };
      acc.spentCents += c.paidAmountCents;
      acc.commissionCents += c.amountCents;
      if (!acc.lastSeenAt || c.createdAt > acc.lastSeenAt) {
        acc.lastSeenAt = c.createdAt;
      }
      byUser.set(c.referredUserId, acc);
    }

    return {
      code,
      link: referralLink(this.appUrl(), code),
      level1Bps: resolveRateBps(1, override, defaults),
      level2Bps: resolveRateBps(2, override, defaults),
      currency: commissions[0]?.currency ?? 'usd',
      availableCents,
      totalCents,
      depositCents,
      paidOutCents,
      referralCount: referrals.length,
      convertedCount: byUser.size,
      history: referrals.map((user) => {
        const acc = byUser.get(user.id);
        return {
          id: user.id,
          referredName: displayReferred(user.firstName, user.email),
          spentCents: acc?.spentCents ?? 0,
          commissionCents: acc?.commissionCents ?? 0,
          currency: commissions[0]?.currency ?? 'usd',
          startDate: user.createdAt,
          lastSeenAt: acc?.lastSeenAt ?? null,
        };
      }),
    };
  }

  /**
   * Registra a comissão de UMA fatura paga. Chamado pelo webhook de billing.
   *
   * Nunca lança: comissão é acessório da cobrança, e uma falha aqui não pode
   * derrubar o processamento do `invoice.paid` (o que faria o Stripe reentregar
   * e o usuário ficar sem acesso). Falha vira warn.
   */
  async accrueForInvoice(params: {
    referredUserId: string;
    providerInvoiceId: string;
    paidAmountCents: number;
    currency: string;
  }): Promise<void> {
    const { referredUserId, providerInvoiceId, paidAmountCents, currency } =
      params;
    try {
      const db = this.prisma.getReadClient();

      // Sobe a cadeia: quem indicou o pagante e quem indicou esse. Duas
      // leituras, não um JOIN recursivo, porque a profundidade é fixa em 2.
      const payer = await db.user.findUnique({
        where: { id: referredUserId },
        select: { referredById: true },
      });
      const level1Id = payer?.referredById ?? null;
      const level1 = level1Id
        ? await db.user.findUnique({
            where: { id: level1Id },
            select: {
              referredById: true,
              affiliateLevel1Bps: true,
              affiliateLevel2Bps: true,
            },
          })
        : null;
      const level2Id = level1?.referredById ?? null;

      const chain = affiliateChain(referredUserId, level1Id, level2Id);
      if (chain.length === 0) return;

      const defaults = await this.getSettings();

      // Uma linha por nível. Cada `create` é independente de propósito: se o
      // nível 2 falhar, o nível 1 já gravado continua valendo — e a trava
      // (fatura, nível) deixa o retry do Stripe reaproveitar o que faltou.
      for (const link of chain) {
        const override =
          link.level === 1 && level1
            ? {
                level1Bps: level1.affiliateLevel1Bps,
                level2Bps: level1.affiliateLevel2Bps,
              }
            : await this.overrideFor(link.affiliateId);

        const rateBps = resolveRateBps(link.level, override, defaults);
        const amountCents = commissionCents(paidAmountCents, rateBps);
        if (amountCents <= 0) continue;

        try {
          await this.prisma.getWriteClient().referralCommission.create({
            data: {
              affiliateId: link.affiliateId,
              referredUserId,
              providerInvoiceId,
              level: link.level,
              paidAmountCents,
              amountCents,
              currency: currency.toLowerCase(),
              rateBps,
            },
          });
          this.logger.log(
            `Comissão nível ${link.level} de ${amountCents} (${currency}) para ${link.affiliateId} pela fatura ${providerInvoiceId}`,
          );
        } catch (err) {
          if (
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === 'P2002'
          ) {
            continue; // este nível já foi apurado — o Stripe reentregou
          }
          throw err;
        }
      }
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        // Fatura já apurada — o Stripe reentregou. Nada a fazer.
        return;
      }
      this.logger.warn(
        `Falha ao apurar comissão da fatura ${providerInvoiceId}: ${(err as Error).message}`,
      );
    }
  }

  // ───────────────────────────── configuração ─────────────────────────────

  /**
   * Percentuais padrão do programa. A linha nasce no primeiro acesso com os
   * valores do código — assim um banco novo já funciona sem passo de seed.
   */
  async getSettings(): Promise<AffiliateRates> {
    const row = await this.prisma.getWriteClient().affiliateSettings.upsert({
      where: { id: SETTINGS_ID },
      create: {
        id: SETTINGS_ID,
        level1Bps: DEFAULT_LEVEL1_BPS,
        level2Bps: DEFAULT_LEVEL2_BPS,
      },
      update: {},
      select: { level1Bps: true, level2Bps: true },
    });
    return row;
  }

  /**
   * Troca os percentuais padrão. Só vale para comissões FUTURAS: cada linha já
   * apurada guarda o `rateBps` que usou, então o extrato do passado não se
   * reescreve quando o time muda a regra.
   */
  async updateSettings(input: {
    level1Bps: number;
    level2Bps: number;
  }): Promise<AffiliateRates> {
    const level1Bps = clampRate(input.level1Bps);
    const level2Bps = clampRate(input.level2Bps);
    const row = await this.prisma.getWriteClient().affiliateSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, level1Bps, level2Bps },
      update: { level1Bps, level2Bps },
      select: { level1Bps: true, level2Bps: true },
    });
    this.logger.log(
      `Percentuais padrão agora: nível 1 ${row.level1Bps}bps, nível 2 ${row.level2Bps}bps`,
    );
    return row;
  }

  /** Exceção negociada de um afiliado, ou null nos dois campos. */
  private async overrideFor(userId: string): Promise<{
    level1Bps: number | null;
    level2Bps: number | null;
  }> {
    const row = await this.prisma.getReadClient().user.findUnique({
      where: { id: userId },
      select: { affiliateLevel1Bps: true, affiliateLevel2Bps: true },
    });
    return {
      level1Bps: row?.affiliateLevel1Bps ?? null,
      level2Bps: row?.affiliateLevel2Bps ?? null,
    };
  }

  /**
   * Define (ou remove) a condição negociada de um afiliado.
   *
   * `null` num campo significa "volta ao padrão global" — e é por isso que o
   * DTO distingue ausente de null: mandar 0 zera a comissão daquele nível sem
   * apagar o vínculo, mandar null devolve o afiliado à regra geral.
   */
  async setAffiliateRates(
    userId: string,
    input: { level1Bps?: number | null; level2Bps?: number | null },
  ): Promise<{ level1Bps: number | null; level2Bps: number | null }> {
    const data: Record<string, number | null> = {};
    if (input.level1Bps !== undefined) {
      data.affiliateLevel1Bps =
        input.level1Bps === null ? null : clampRate(input.level1Bps);
    }
    if (input.level2Bps !== undefined) {
      data.affiliateLevel2Bps =
        input.level2Bps === null ? null : clampRate(input.level2Bps);
    }

    try {
      const row = await this.prisma.getWriteClient().user.update({
        where: { id: userId },
        data,
        select: { affiliateLevel1Bps: true, affiliateLevel2Bps: true },
      });
      return {
        level1Bps: row.affiliateLevel1Bps,
        level2Bps: row.affiliateLevel2Bps,
      };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        throw new NotFoundException('User not found');
      }
      throw err;
    }
  }

  /**
   * Lista para o admin: quem tem código de indicação, com o que já rendeu e a
   * condição de cada um.
   */
  async listAffiliates(): Promise<AdminAffiliateRow[]> {
    const db = this.prisma.getWriteClient();
    const users = await db.user.findMany({
      where: { referralCode: { not: null }, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: ADMIN_LIST_LIMIT,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        referralCode: true,
        affiliateLevel1Bps: true,
        affiliateLevel2Bps: true,
        _count: { select: { referrals: true } },
      },
    });
    if (users.length === 0) return [];

    // Uma consulta para os totais de todos, em vez de uma por afiliado.
    const totals = await db.referralCommission.groupBy({
      by: ['affiliateId'],
      where: { affiliateId: { in: users.map((u) => u.id) } },
      _sum: { amountCents: true },
    });
    const earned = new Map(
      totals.map((t) => [t.affiliateId, t._sum.amountCents ?? 0]),
    );

    return users.map((u) => ({
      id: u.id,
      name: `${u.firstName} ${u.lastName}`.trim() || u.email,
      email: u.email,
      referralCode: u.referralCode as string,
      level1Bps: u.affiliateLevel1Bps,
      level2Bps: u.affiliateLevel2Bps,
      referralCount: u._count.referrals,
      totalEarnedCents: earned.get(u.id) ?? 0,
    }));
  }
}

/** Percentual saneado para gravar: inteiro, entre 0 e 100%. */
function clampRate(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.trunc(value), MAX_RATE_BPS);
}

/**
 * Como o indicado aparece no extrato do afiliado.
 *
 * O afiliado NÃO recebe o e-mail de quem indicou: ele só precisa distinguir
 * uma linha da outra, e entregar a lista de e-mails de clientes pagantes a
 * qualquer um que crie um código seria vazamento de base.
 */
function displayReferred(firstName: string, email: string): string {
  const name = firstName.trim();
  if (name) return name;
  const [local] = email.split('@');
  if (local.length <= 2) return `${local[0] ?? '?'}***`;
  return `${local.slice(0, 2)}***`;
}
