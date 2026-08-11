import { Chain } from '@prisma/client';

/**
 * Atribuição de trades a FONTES por lead-lag (puro, sem I/O — testável).
 *
 * Ideia: uma "Fonte" é representada por carteiras on-chain. Quando o usuário
 * COMPRA um token logo depois de a fonte ter comprado o MESMO token (mesma
 * chain), dentro da janela da fonte, o trade do usuário é atribuído àquela fonte
 * ("segui a call"). Uma compra pode casar com várias fontes (todas que chamaram).
 */

const HOUR_MS = 3_600_000;

export interface UserBuy {
  tradeId: string;
  mint: string;
  chain: Chain;
  blockTimeMs: number;
}

export interface LeadBuy {
  tradeId: string;
  walletId: string;
  sourceId: string;
  mint: string;
  chain: Chain;
  blockTimeMs: number;
}

export interface Attribution {
  tradeId: string; // compra do usuário
  sourceId: string;
  leadTradeId: string; // compra da fonte que casou
  leadWalletId: string;
  lagSeconds: number; // defasagem = minha compra − compra da fonte (≥ 0)
}

/** Chave de casamento: token é (chain, mint) — o mesmo símbolo em chains diferentes é outro ativo. */
function tokenKey(chain: Chain, mint: string): string {
  return `${chain}|${mint}`;
}

/** Maior índice i com `sorted[i].blockTimeMs <= t` (busca binária). -1 se nenhum. */
function rightmostAtOrBefore(sorted: LeadBuy[], t: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid].blockTimeMs <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * Casa cada compra do usuário com as fontes que compraram o mesmo token antes,
 * dentro da janela de cada fonte. Para cada (compra, fonte) escolhe a compra da
 * fonte MAIS PRÓXIMA (menor defasagem). Complexidade: O(U·S·log L) no pior caso,
 * mas na prática O(U·log L) (poucas fontes negociam o mesmo token).
 *
 * @param windowHoursBySource janela de atribuição (horas) por fonte. Uma fonte
 *   ausente do mapa é ignorada (ex.: fonte inativa).
 */
export function attributeBuys(
  userBuys: UserBuy[],
  leadBuys: LeadBuy[],
  windowHoursBySource: Map<string, number>,
): Attribution[] {
  // Índice: tokenKey → sourceId → compras da fonte ordenadas por tempo asc.
  const index = new Map<string, Map<string, LeadBuy[]>>();
  for (const lead of leadBuys) {
    if (!windowHoursBySource.has(lead.sourceId)) continue; // fonte inativa/desconhecida
    const key = tokenKey(lead.chain, lead.mint);
    let bySource = index.get(key);
    if (!bySource) {
      bySource = new Map();
      index.set(key, bySource);
    }
    const arr = bySource.get(lead.sourceId);
    if (arr) arr.push(lead);
    else bySource.set(lead.sourceId, [lead]);
  }
  for (const bySource of index.values()) {
    for (const arr of bySource.values()) {
      arr.sort((a, b) => a.blockTimeMs - b.blockTimeMs);
    }
  }

  const out: Attribution[] = [];
  for (const buy of userBuys) {
    const bySource = index.get(tokenKey(buy.chain, buy.mint));
    if (!bySource) continue;

    for (const [sourceId, leads] of bySource) {
      const windowMs = (windowHoursBySource.get(sourceId) as number) * HOUR_MS;
      const i = rightmostAtOrBefore(leads, buy.blockTimeMs);
      if (i < 0) continue;
      const lead = leads[i];
      const lagMs = buy.blockTimeMs - lead.blockTimeMs;
      if (lagMs > windowMs) continue; // fora da janela → não atribui

      out.push({
        tradeId: buy.tradeId,
        sourceId,
        leadTradeId: lead.tradeId,
        leadWalletId: lead.walletId,
        lagSeconds: Math.round(lagMs / 1000),
      });
    }
  }
  return out;
}
