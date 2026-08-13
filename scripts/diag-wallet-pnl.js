/**
 * Diagnóstico de PnL de UMA carteira: FIFO em USD (casado vs incluindo windfall),
 * distribuição de quote, % de preço resolvido, e o equivalente em SOL. Serve p/ achar
 * por que o "Resultado" diverge do que o usuário fez.
 *
 * Uso:  node scripts/diag-wallet-pnl.js <walletId> [YYYY-MM-DD janela]
 */
const { PrismaClient } = require('@prisma/client');

const WSOL = 'So11111111111111111111111111111111111111112';
const STABLES = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);
const n = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

async function main() {
  const prisma = new PrismaClient();
  const walletId = process.argv[2];
  if (!walletId) throw new Error('Informe o walletId');
  const since = process.argv[3] ? new Date(process.argv[3] + 'T00:00:00Z') : null;
  // Default: D30 (o dashboard usa D30).
  const windowStart = since || new Date(Date.now() - 30 * 86400000);

  const w = await prisma.wallet.findUnique({
    where: { id: walletId },
    select: { address: true, chain: true },
  });
  console.log(`Carteira ${w?.address} (${w?.chain}) — janela desde ${windowStart.toISOString().slice(0, 10)}`);

  const rows = await prisma.trade.findMany({
    where: { walletId },
    select: {
      side: true, blockTime: true, baseMint: true, baseAmount: true,
      quoteMint: true, quoteAmount: true, usdValue: true, priceUsd: true,
      feeUsd: true, priceResolved: true,
    },
    orderBy: { blockTime: 'asc' },
  });
  console.log(`Total trades (all-time): ${rows.length}`);

  const inWin = rows.filter((r) => r.blockTime >= windowStart);
  console.log(`Trades na janela: ${inWin.length}`);

  const resolved = inWin.filter((r) => r.priceResolved).length;
  console.log(`priceResolved na janela: ${resolved}/${inWin.length}`);
  const byQuote = {};
  for (const r of inWin) {
    const k = r.quoteMint === WSOL ? 'WSOL' : STABLES.has(r.quoteMint) ? 'STABLE' : 'OUTRO';
    byQuote[k] = (byQuote[k] || 0) + 1;
  }
  console.log('Quote dist (janela):', byQuote);

  // FIFO em USD. lotes por mint = {qty, unitCostUsd}. Constrói com TODOS os trades
  // (base de custo pode ser anterior à janela); realiza só vendas DENTRO da janela.
  const lots = new Map();
  let matchedUsd = 0;       // PnL casado (exclui windfall) — DENTRO da janela
  let windfallUsd = 0;      // proceeds de vendas sem lote (zero-cost) — DENTRO da janela
  let feesUsd = 0;
  let matchedSells = 0, windfallSells = 0, partialSells = 0;

  for (const t of rows) {
    const win = t.blockTime >= windowStart;
    const qty = n(t.baseAmount);
    const price = n(t.priceUsd);
    if (win) feesUsd += n(t.feeUsd);
    let lot = lots.get(t.baseMint);
    if (!lot) { lot = []; lots.set(t.baseMint, lot); }

    if (t.side === 'BUY') {
      lot.push({ qty, unitCost: price });
      continue;
    }
    // SELL
    let remaining = qty, matchedQty = 0, cost = 0;
    while (remaining > 1e-12 && lot.length > 0) {
      const l = lot[0];
      const take = Math.min(remaining, l.qty);
      cost += l.unitCost * take;
      l.qty -= take; matchedQty += take; remaining -= take;
      if (l.qty <= 1e-12) lot.shift();
    }
    if (!win) continue;
    if (matchedQty <= 0) { windfallSells++; windfallUsd += qty * price; continue; }
    if (remaining > 1e-9) partialSells++;
    matchedSells++;
    matchedUsd += matchedQty * price - cost;       // PnL de trading casado
    windfallUsd += remaining * price;              // parte não-casada (zero-cost)
  }

  console.log('──────────────────────────────────────────');
  console.log(`SELLs casados: ${matchedSells} | windfall puros: ${windfallSells} | parciais: ${partialSells}`);
  console.log(`Realized USD CASADO (exclui windfall) : $${matchedUsd.toFixed(2)}`);
  console.log(`Windfall USD (zero-cost proceeds)     : $${windfallUsd.toFixed(2)}`);
  console.log(`Realized USD CASADO + windfall        : $${(matchedUsd + windfallUsd).toFixed(2)}`);
  console.log(`Fees USD (janela)                     : $${feesUsd.toFixed(2)}`);
  console.log(`Net (casado − fees)                   : $${(matchedUsd - feesUsd).toFixed(2)}`);

  // ── FIFO em SOL (pernas WSOL): SOL realizado casado + fluxo líquido ──
  const solLots = new Map();
  let realizedSol = 0, netFlowSol = 0;
  for (const t of rows) {
    const win = t.blockTime >= windowStart;
    const qty = n(t.baseAmount);
    const sol = t.quoteMint === WSOL ? n(t.quoteAmount) : 0;
    let lot = solLots.get(t.baseMint);
    if (!lot) { lot = []; solLots.set(t.baseMint, lot); }
    if (win && t.quoteMint === WSOL) netFlowSol += (t.side === 'SELL' ? 1 : -1) * sol;
    if (t.side === 'BUY') { lot.push({ qty, solCost: sol }); continue; }
    let remaining = qty, mq = 0, cost = 0;
    while (remaining > 1e-12 && lot.length > 0) {
      const l = lot[0];
      const take = Math.min(remaining, l.qty);
      const frac = l.qty > 0 ? take / l.qty : 0;
      cost += l.solCost * frac; l.solCost -= l.solCost * frac;
      l.qty -= take; mq += take; remaining -= take;
      if (l.qty <= 1e-12) lot.shift();
    }
    if (!win || mq <= 0) continue;
    const proceeds = qty > 0 ? sol * (mq / qty) : 0;
    realizedSol += proceeds - cost;
  }
  console.log('──────────────────────────────────────────');
  console.log(`SOL realizado CASADO (FIFO, janela)   : ${realizedSol.toFixed(4)} SOL`);
  console.log(`Fluxo líquido SOL (recebido−gasto)    : ${netFlowSol.toFixed(4)} SOL`);
  console.log(`Sol via USD/preço (fórmula antiga~76) : ${(matchedUsd / 76).toFixed(4)} SOL`);

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
