/**
 * Diagnóstico do "Sol acumulado": replica o FIFO em SOL (computeSolBenchmark)
 * contra os dados REAIS do banco e compara com a fórmula ANTIGA (PnL-USD / preço
 * do SOL). Diz se o 4,6 exibido é código velho ainda rodando ou o FIFO novo.
 *
 * Uso:  node scripts/diag-sol-benchmark.js [email]
 */
const { PrismaClient } = require('@prisma/client');

const WSOL = 'So11111111111111111111111111111111111111112';
const SOL_STABLES = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

async function main() {
  const prisma = new PrismaClient();
  const email = process.argv[2] || 'atroposys@gmail.com';

  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) throw new Error(`Usuário não encontrado: ${email}`);

  const wallets = await prisma.wallet.findMany({
    where: { userId: user.id, kind: 'OWN' },
    select: { id: true, address: true, chain: true },
  });
  const walletIds = wallets.map((w) => w.id);
  console.log(`Usuário ${email} — ${wallets.length} carteiras OWN:`);
  for (const w of wallets) console.log(`  ${w.chain} ${w.address} (${w.id})`);

  const rows = await prisma.trade.findMany({
    where: { walletId: { in: walletIds } },
    select: {
      side: true,
      blockTime: true,
      baseMint: true,
      baseAmount: true,
      quoteMint: true,
      quoteAmount: true,
      feeNative: true,
      chainType: true,
    },
    orderBy: { blockTime: 'asc' },
  });
  console.log(`\nTotal de trades OWN: ${rows.length}`);

  // Distribuição de quoteMint (pra saber se as pernas são WSOL/stable/outros).
  const byQuote = new Map();
  for (const r of rows) {
    const key =
      r.quoteMint === WSOL ? 'WSOL' : SOL_STABLES.has(r.quoteMint) ? 'STABLE' : 'OUTRO';
    byQuote.set(key, (byQuote.get(key) || 0) + 1);
  }
  console.log('Pernas por quote:', Object.fromEntries(byQuote));

  // ── FIFO em SOL (réplica de computeSolBenchmark, sem janela = all-time) ──
  const solOfLeg = (quoteMint, quoteAmount) => {
    if (quoteMint === WSOL) return num(quoteAmount);
    if (SOL_STABLES.has(quoteMint)) return 0; // ignora preço do dia neste diag
    return 0;
  };

  const lots = new Map();
  let realizedSolGross = 0;
  let feesSolTotal = 0;
  let windfallSells = 0;
  let matchedSells = 0;

  for (const t of rows) {
    feesSolTotal += num(t.feeNative);
    const qty = num(t.baseAmount);
    const sol = solOfLeg(t.quoteMint, t.quoteAmount);
    let lot = lots.get(t.baseMint);
    if (!lot) {
      lot = [];
      lots.set(t.baseMint, lot);
    }
    if (t.side === 'BUY') {
      lot.push({ qty, solCost: sol });
      continue;
    }
    // SELL
    let remaining = qty;
    let matchedQty = 0;
    let matchedCost = 0;
    while (remaining > 1e-12 && lot.length > 0) {
      const l = lot[0];
      const take = Math.min(remaining, l.qty);
      const frac = l.qty > 0 ? take / l.qty : 0;
      matchedCost += l.solCost * frac;
      l.solCost -= l.solCost * frac;
      l.qty -= take;
      matchedQty += take;
      remaining -= take;
      if (l.qty <= 1e-12) lot.shift();
    }
    if (matchedQty <= 0) {
      windfallSells++;
      continue;
    }
    matchedSells++;
    const proceeds = qty > 0 ? sol * (matchedQty / qty) : 0;
    realizedSolGross += proceeds - matchedCost;
  }

  console.log(`\nSELLs casados: ${matchedSells} | windfall (sem lote): ${windfallSells}`);

  // ── Fluxo BRUTO de SOL nas pernas WSOL (independente de FIFO) ──
  let solSpentBuys = 0; // SOL que saiu comprando (quote WSOL, side BUY)
  let solRecvSells = 0; // SOL que entrou vendendo (quote WSOL, side SELL)
  for (const t of rows) {
    if (t.quoteMint !== WSOL) continue;
    if (t.side === 'BUY') solSpentBuys += num(t.quoteAmount);
    else solRecvSells += num(t.quoteAmount);
  }

  // ── Amostra de 5 BUY e 5 SELL WSOL p/ conferir unidade do quoteAmount ──
  const sampleBuys = rows.filter((r) => r.quoteMint === WSOL && r.side === 'BUY').slice(0, 5);
  const sampleSells = rows.filter((r) => r.quoteMint === WSOL && r.side === 'SELL').slice(0, 5);
  console.log('\nAmostra BUY  (baseAmount / quoteAmount SOL):');
  sampleBuys.forEach((r) => console.log(`  ${r.baseMint.slice(0, 6)}… base=${num(r.baseAmount)} quoteSOL=${num(r.quoteAmount)}`));
  console.log('Amostra SELL (baseAmount / quoteAmount SOL):');
  sampleSells.forEach((r) => console.log(`  ${r.baseMint.slice(0, 6)}… base=${num(r.baseAmount)} quoteSOL=${num(r.quoteAmount)}`));

  console.log('\n──────────────────────────────────────────');
  console.log(`SOL gasto em BUYs (WSOL)              : ${solSpentBuys.toFixed(4)} SOL`);
  console.log(`SOL recebido em SELLs (WSOL)          : ${solRecvSells.toFixed(4)} SOL`);
  console.log(`Fluxo LÍQUIDO (recebido − gasto)      : ${(solRecvSells - solSpentBuys).toFixed(4)} SOL`);
  console.log('──────────────────────────────────────────');
  console.log(`FIFO SOL realizado (BRUTO, all-time)  : ${realizedSolGross.toFixed(4)} SOL`);

  // ── Fluxo líquido de SOL por JANELA (o benchmark é janelado por período) ──
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const windows = { D30: 30, D90: 90, M12: 365, all: Infinity };
  const netFlowSince = (sinceMs) => {
    let net = 0;
    for (const t of rows) {
      if (t.quoteMint !== WSOL) continue;
      if (t.blockTime.getTime() < sinceMs) continue;
      net += (t.side === 'SELL' ? 1 : -1) * num(t.quoteAmount);
    }
    return net;
  };
  console.log('\nFluxo líquido de SOL por janela (só pernas WSOL):');
  for (const [name, days] of Object.entries(windows)) {
    const since = days === Infinity ? 0 : now - days * DAY;
    console.log(`  ${name.padEnd(4)}: ${netFlowSince(since).toFixed(2)} SOL`);
  }

  const times = rows.map((r) => r.blockTime.getTime());
  console.log(
    `\nRange de trades: ${new Date(Math.min(...times)).toISOString().slice(0, 10)} → ${new Date(Math.max(...times)).toISOString().slice(0, 10)}`,
  );

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
