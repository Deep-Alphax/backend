/**
 * Semeia as regras de monitoramento do bot antigo (`bot/index.js`) na tabela
 * DiscordMonitor. Idempotente: pula regras que já existem (mesmo canal+padrão+
 * telegram). Não precisa de auth — fala direto com o Postgres via Prisma.
 *
 * Uso:  node scripts/seed-monitors.js
 */
const { PrismaClient } = require('@prisma/client');

// ── Regras portadas VERBATIM do bot/index.js (target→channelId, frase→pattern, to→telegramChatId) ──
const MONITORS = [
  { name: 'CA Ethereum (0x…)', target: '1013855610871226480', frase: '/0x[a-fA-F0-9]{40}/i', to: '-1004299449661' },
  { name: 'CA Solana (base58)', target: '1013855610871226480', frase: '/[1-9A-HJ-NP-Za-km-z]{32,44}/', to: '-1004299449661' },
  { name: 'FDV (K)', target: '1437117920240078881', frase: '/💎\\s*FDV:\\s*`?\\d+(?:\\.\\d+)?K`?/i', to: '-1004299449661' },
  { name: 'PVP matches', target: '1437117920240078881', frase: 'PVP matches', to: '-1004299449661' },
  { name: 'PVP matches', target: '991099143705600000', frase: 'PVP matches', to: '-1004299449661' },
  { name: 'FourMeme', target: '1452022973568516330', frase: 'FourMeme', to: '-1004299449661' },
  { name: 'FDV (K)', target: '1452022855255588946', frase: '/💎\\s*FDV:\\s*`?\\d+(?:\\.\\d+)?K`?/i', to: '-1004299449661' },
  { name: 'FDV (K)', target: '1452023096046387240', frase: '/\\s*FDV:\\s*`?\\d+(?:\\.\\d+)?K`?/i', to: '-1004299449661' },
  { name: 'FDV (K)', target: '1013855610871226480', frase: '/💎\\s*FDV:\\s*`?\\d+(?:\\.\\d+)?K`?/i', to: '-1004299449661' },
  { name: 'USD', target: '1013855610871226480', frase: '💰 USD', to: '-1004299449661' },
];

const prisma = new PrismaClient();

(async () => {
  let created = 0;
  let skipped = 0;

  for (const m of MONITORS) {
    const exists = await prisma.discordMonitor.findFirst({
      where: { channelId: m.target, pattern: m.frase, telegramChatId: m.to },
      select: { id: true },
    });

    if (exists) {
      skipped += 1;
      console.log(`↷ já existe: [${m.target}] ${m.frase}`);
      continue;
    }

    await prisma.discordMonitor.create({
      data: {
        name: m.name,
        channelId: m.target,
        pattern: m.frase,
        telegramChatId: m.to,
        waitForBotReply: true,
        isActive: true,
      },
    });
    created += 1;
    console.log(`✅ criada: [${m.target}] ${m.frase}`);
  }

  console.log(`\nResumo: ${created} criada(s), ${skipped} pulada(s), ${MONITORS.length} no total.`);
})()
  .catch((e) => {
    console.error('Erro:', e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
