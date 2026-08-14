/**
 * Migração de dados: per-user Wallet → Wallet compartilhada (canônica) + WalletCatalog.
 *
 * Agrupa Wallet por (chain, addressNorm), elege a canônica (mais trades → lastSyncedAt
 * preenchido → mais antiga), mescla os trades/posições das duplicatas na canônica
 * (movendo os que não colidem; os colidentes caem por cascade ao deletar a duplicata),
 * cria uma entrada de WalletCatalog por linha antiga (papel derivado de kind), e apaga
 * as linhas duplicadas. Por fim limpa MetricSnapshot e TradeAttribution (recomputam).
 *
 * NÃO dropa colunas (userId/kind/... seguem na Wallet) — isso fica p/ a migration de
 * cleanup, só depois de validado. Assim o passo é reversível por re-derivação.
 *
 * Uso:
 *   node scripts/migrate-shared-wallets.js            # DRY-RUN (só relatório)
 *   node scripts/migrate-shared-wallets.js --apply    # aplica
 */
const { PrismaClient } = require('@prisma/client');

const APPLY = process.argv.includes('--apply');

async function main() {
  const prisma = new PrismaClient();
  const log = (...a) => console.log(...a);
  log(APPLY ? '=== APPLY ===' : '=== DRY-RUN (nada será alterado) ===');

  const wallets = await prisma.wallet.findMany({
    select: {
      id: true, userId: true, chain: true, addressNorm: true, address: true,
      kind: true, sourceId: true, label: true, lastSyncedAt: true, createdAt: true,
      _count: { select: { trades: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  log(`Wallets totais: ${wallets.length}`);

  // Agrupa por (chain, addressNorm).
  const groups = new Map();
  for (const w of wallets) {
    const k = `${w.chain}|${w.addressNorm}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(w);
  }
  log(`Endereços canônicos (chain+addressNorm): ${groups.size}`);

  // Elege canônica: mais trades → lastSyncedAt preenchido → createdAt mais antigo.
  const pickCanonical = (rows) =>
    [...rows].sort((a, b) => {
      if (b._count.trades !== a._count.trades) return b._count.trades - a._count.trades;
      const la = a.lastSyncedAt ? 1 : 0, lb = b.lastSyncedAt ? 1 : 0;
      if (lb !== la) return lb - la;
      return a.createdAt - b.createdAt;
    })[0];

  let catalogPlanned = 0, dupsPlanned = 0, tradesMovedPlanned = 0, tradesCascadePlanned = 0;
  const dupGroups = [];

  for (const [key, rows] of groups) {
    const canonical = pickCanonical(rows);
    catalogPlanned += rows.length; // 1 entrada de catálogo por linha antiga
    if (rows.length > 1) {
      dupsPlanned += rows.length - 1;
      dupGroups.push({ key, canonical, rows });
      for (const r of rows) {
        if (r.id === canonical.id) continue;
        // Quantos trades da duplicata NÃO colidem com a canônica → serão movidos.
        // (colisão = mesmo txHash+baseMint+side já presente na canônica)
        const dupTrades = await prisma.trade.findMany({
          where: { walletId: r.id },
          select: { txHash: true, baseMint: true, side: true },
        });
        let move = 0;
        for (const t of dupTrades) {
          const clash = await prisma.trade.count({
            where: { walletId: canonical.id, txHash: t.txHash, baseMint: t.baseMint, side: t.side },
          });
          if (clash === 0) move++; else tradesCascadePlanned++;
        }
        tradesMovedPlanned += move;
      }
    }
  }

  log('──────────────────────────────────────────');
  log(`Entradas de WalletCatalog a criar : ${catalogPlanned}`);
  log(`Linhas Wallet duplicadas a apagar : ${dupsPlanned}`);
  log(`Trades a MOVER p/ canônica        : ${tradesMovedPlanned}`);
  log(`Trades duplicados (cascade/apagar): ${tradesCascadePlanned}`);
  log('Grupos com duplicata:');
  for (const g of dupGroups) {
    log(`  ${g.key.slice(0, 40)}… → canônica ${g.canonical.id} (${g.canonical._count.trades} trades); ${g.rows.length} users`);
  }

  if (!APPLY) {
    log('\nDRY-RUN concluído. Rode com --apply para efetivar.');
    await prisma.$disconnect();
    return;
  }

  // ─────────────────────────── APPLY ───────────────────────────
  const roleOf = (kind) => (kind === 'SOURCE' ? 'SOURCE' : 'TRACKED');
  let created = 0, deleted = 0, moved = 0;

  for (const [, rows] of groups) {
    const canonical = pickCanonical(rows);

    for (const r of rows) {
      // 1) cria a entrada de catálogo (idempotente por (userId, walletId)).
      await prisma.walletCatalog.upsert({
        where: { userId_walletId: { userId: r.userId, walletId: canonical.id } },
        create: {
          userId: r.userId, walletId: canonical.id,
          role: roleOf(r.kind), sourceId: r.sourceId ?? null, label: r.label ?? null,
        },
        update: {}, // se já existe, mantém
      });
      created++;

      if (r.id === canonical.id) continue;

      // 2) move trades não-colidentes p/ a canônica (SQL: NOT EXISTS evita violar a unique).
      const res = await prisma.$executeRaw`
        UPDATE "Trade" t SET "walletId" = ${canonical.id}
        WHERE t."walletId" = ${r.id}
          AND NOT EXISTS (
            SELECT 1 FROM "Trade" c
            WHERE c."walletId" = ${canonical.id}
              AND c."txHash" = t."txHash"
              AND c."baseMint" = t."baseMint"
              AND c."side" = t."side"
          )`;
      moved += res;

      // 3) move posições não-colidentes (unique walletId+mint).
      await prisma.$executeRaw`
        UPDATE "TokenPosition" p SET "walletId" = ${canonical.id}
        WHERE p."walletId" = ${r.id}
          AND NOT EXISTS (
            SELECT 1 FROM "TokenPosition" c
            WHERE c."walletId" = ${canonical.id} AND c."mint" = p."mint"
          )`;

      // 4) apaga a linha duplicada (cascade: trades/posições colidentes, snapshots).
      await prisma.wallet.delete({ where: { id: r.id } });
      deleted++;
    }
  }

  // 5) limpa caches derivados (recomputam com a nova lógica de escopo).
  const snaps = await prisma.metricSnapshot.deleteMany({});
  const attrs = await prisma.tradeAttribution.deleteMany({});

  log('──────────────────────────────────────────');
  log(`WalletCatalog criados : ${created}`);
  log(`Wallets apagadas      : ${deleted}`);
  log(`Trades movidos        : ${moved}`);
  log(`MetricSnapshot limpos : ${snaps.count}`);
  log(`TradeAttribution limpo: ${attrs.count}`);
  log('APPLY concluído.');
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
