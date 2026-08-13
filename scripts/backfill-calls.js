/**
 * Backfill: extrai as "calls" (CA/mint + ticker) das CapturedMessage JÁ existentes
 * e popula a tabela MessageCall (usada no cruzamento trade × call → fontes por
 * Discord). Idempotente: pula mensagens que já têm calls. Roda em lotes.
 *
 * Uso:  node scripts/backfill-calls.js
 */
const { PrismaClient } = require('@prisma/client');

const EVM_RE = /0x[a-fA-F0-9]{40}/g;
const SOL_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
const TICKER_RE = /\$([A-Za-z][A-Za-z0-9]{1,14})/g;

function extract(text, links) {
  const hay = [text || '', ...(links || [])].join('\n');
  const byKey = new Map();
  for (const m of hay.matchAll(EVM_RE)) {
    const mint = m[0].toLowerCase();
    byKey.set('EVM|' + mint, { chainType: 'EVM', mint });
  }
  const solHay = hay.replace(EVM_RE, ' ');
  for (const m of solHay.matchAll(SOL_RE)) {
    byKey.set('SOLANA|' + m[0], { chainType: 'SOLANA', mint: m[0] });
  }
  const tickers = new Set();
  for (const m of hay.matchAll(TICKER_RE)) tickers.add(m[1].toUpperCase());
  return {
    mints: [...byKey.values()].slice(0, 25),
    tickers: [...tickers].slice(0, 25),
  };
}

const prisma = new PrismaClient();
const BATCH = 500;

(async () => {
  let skip = 0;
  let processed = 0;
  let callsCreated = 0;
  let msgsWithCalls = 0;

  for (;;) {
    const msgs = await prisma.capturedMessage.findMany({
      orderBy: { createdAt: 'asc' },
      skip,
      take: BATCH,
      select: {
        id: true,
        text: true,
        links: true,
        guildName: true,
        channelId: true,
        createdAt: true,
        _count: { select: { calls: true } },
      },
    });
    if (msgs.length === 0) break;

    for (const m of msgs) {
      processed += 1;
      if (m._count.calls > 0) continue; // já tem calls → idempotente

      const { mints, tickers } = extract(m.text, m.links);
      if (!mints.length && !tickers.length) continue;

      const data = [
        ...mints.map((r) => ({
          capturedMessageId: m.id,
          chainType: r.chainType,
          mint: r.mint,
          guildName: m.guildName,
          channelId: m.channelId,
          calledAt: m.createdAt,
        })),
        ...tickers.map((t) => ({
          capturedMessageId: m.id,
          ticker: t,
          guildName: m.guildName,
          channelId: m.channelId,
          calledAt: m.createdAt,
        })),
      ];
      await prisma.messageCall.createMany({ data });
      callsCreated += data.length;
      msgsWithCalls += 1;
    }

    skip += msgs.length;
    process.stdout.write(`\rProcessadas ${processed}…`);
  }

  console.log(
    `\n✅ ${processed} mensagens processadas · ${msgsWithCalls} com calls · ${callsCreated} calls criadas.`,
  );
})()
  .catch((e) => {
    console.error('Erro:', e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
