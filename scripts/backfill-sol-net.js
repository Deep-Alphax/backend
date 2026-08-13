/**
 * Backfill: recomputa o `quoteAmount` (SOL) das trades Solana JÁ gravadas usando o
 * DELTA NATIVO real da carteira (líquido de taxa da plataforma + tips Jito + rent),
 * em vez da perna WSOL bruta que superestimava o resultado. Escala `usdValue`/`priceUsd`
 * na mesma proporção. Só toca trades com quote em WSOL.
 *
 * DRY-RUN por padrão (não grava). Para aplicar:  node scripts/backfill-sol-net.js --apply [walletId]
 * Sem walletId, processa todas as carteiras OWN Solana.
 */
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const https = require('https');

const WSOL = 'So11111111111111111111111111111111111111112';
const APPLY = process.argv.includes('--apply');
const WALLET_ARG = process.argv
  .slice(2)
  .find((a) => /^[a-z0-9]{20,}$/.test(a));

function heliusKey() {
  const env = fs.readFileSync('.env', 'utf8');
  const m = env.match(/^HELIUS_API_KEY\s*=\s*"?([^"\r\n]+)"?/m);
  return m ? m[1].trim() : '';
}

function fetchTxs(key, sigs) {
  const body = JSON.stringify({ transactions: sigs });
  return new Promise((resolve, reject) => {
    const req = https.request(
      'https://api.helius.xyz/v0/transactions?api-key=' + key,
      { method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(new Error('parse: ' + d.slice(0, 120)));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** Recomputa o SOL real do swap a partir da tx (mesma regra do reconstruct). */
function realSol(tx, address) {
  const netWsol = (() => {
    let v = 0;
    for (const tt of tx?.tokenTransfers ?? []) {
      if (tt.mint !== WSOL) continue;
      const a = Number(tt.tokenAmount) || 0;
      if (tt.fromUserAccount === address) v -= a;
      if (tt.toUserAccount === address) v += a;
    }
    return Math.abs(v);
  })();
  let solNative = 0,
    hasNative = false;
  for (const n of tx?.nativeTransfers ?? []) {
    const a = (Number(n?.amount) || 0) / 1e9;
    if (n.fromUserAccount === address) {
      solNative -= a;
      hasNative = true;
    }
    if (n.toUserAccount === address) {
      solNative += a;
      hasNative = true;
    }
  }
  const baseFee = tx?.feePayer === address ? (Number(tx?.fee) || 0) / 1e9 : 0;
  if (netWsol >= 1e-12 && Math.abs(solNative) < 0.5 * netWsol) return netWsol;
  if (hasNative && Math.abs(solNative) > 1e-9) return Math.abs(solNative - baseFee);
  return netWsol;
}

async function processWallet(prisma, key, wallet) {
  const trades = await prisma.trade.findMany({
    where: { walletId: wallet.id, quoteMint: WSOL },
    select: {
      id: true, txHash: true, side: true, quoteAmount: true,
      usdValue: true, priceUsd: true,
    },
    orderBy: { blockTime: 'asc' },
  });
  if (trades.length === 0) return { wallet: wallet.address, updated: 0 };

  // Busca as txs em lotes de 100.
  const sigs = [...new Set(trades.map((t) => t.txHash))];
  const txById = new Map();
  for (let i = 0; i < sigs.length; i += 100) {
    const arr = await fetchTxs(key, sigs.slice(i, i + 100));
    for (const tx of arr || []) txById.set(tx.signature, tx);
  }

  let updated = 0;
  let sumOldSigned = 0, sumNewSigned = 0;
  for (const t of trades) {
    const tx = txById.get(t.txHash);
    if (!tx) continue;
    const oldSol = Number(t.quoteAmount);
    const newSol = realSol(tx, wallet.address);
    const sign = t.side === 'SELL' ? 1 : -1;
    sumOldSigned += sign * oldSol;
    sumNewSigned += sign * newSol;
    if (!(newSol > 0) || Math.abs(newSol - oldSol) < 1e-9) continue;
    const ratio = newSol / oldSol;
    updated++;
    if (APPLY) {
      await prisma.trade.update({
        where: { id: t.id },
        data: {
          quoteAmount: newSol.toFixed(18),
          usdValue: (Number(t.usdValue) * ratio).toFixed(12),
          priceUsd: (Number(t.priceUsd) * ratio).toFixed(18),
        },
      });
    }
  }

  console.log(
    `  ${wallet.address}: ${trades.length} trades WSOL, ${updated} ${APPLY ? 'atualizadas' : 'a atualizar'} | ` +
      `fluxo SOL: ${sumOldSigned.toFixed(3)} → ${sumNewSigned.toFixed(3)}`,
  );
  return { userId: wallet.userId, updated };
}

async function main() {
  const key = heliusKey();
  if (!key) throw new Error('HELIUS_API_KEY ausente no .env');
  const prisma = new PrismaClient();

  const wallets = await prisma.wallet.findMany({
    where: {
      kind: 'OWN',
      chain: 'SOLANA',
      ...(WALLET_ARG ? { id: WALLET_ARG } : {}),
    },
    select: { id: true, address: true, userId: true },
  });
  console.log(`${APPLY ? 'APLICANDO' : 'DRY-RUN'} — ${wallets.length} carteira(s) OWN Solana\n`);

  const affectedUsers = new Set();
  for (const w of wallets) {
    const r = await processWallet(prisma, key, w);
    if (r.updated > 0 && r.userId) affectedUsers.add(r.userId);
  }

  if (APPLY && affectedUsers.size > 0) {
    // Invalida Bloco 1 (snapshots) e força a chave de cache do Bloco 2 (bump do maxCreatedAt).
    const del = await prisma.metricSnapshot.deleteMany({
      where: { userId: { in: [...affectedUsers] } },
    });
    console.log(`\nSnapshots deletados: ${del.count}`);
    for (const w of wallets) {
      const last = await prisma.trade.findFirst({
        where: { walletId: w.id },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (last) await prisma.trade.update({ where: { id: last.id }, data: { createdAt: new Date() } });
    }
    console.log('Cache do Bloco 2 invalidado (bump de createdAt).');
  }
  console.log(`\n${APPLY ? 'Aplicado.' : 'Dry-run (nada gravado). Rode com --apply para gravar.'}`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
