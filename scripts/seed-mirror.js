/**
 * Configura ESPELHO TOTAL: para cada canal abaixo, remove as regras existentes
 * daquele canal e cria UMA regra sem padrão (espelha TODAS as mensagens → Telegram).
 * Idempotente: rodar de novo deixa o mesmo estado.
 *
 * Edite CHANNELS / TELEGRAM_CHAT abaixo e rode:  node scripts/seed-mirror.js
 */
const { PrismaClient } = require('@prisma/client');

// Destino no Telegram (o mesmo do bot antigo). Troque se quiser.
const TELEGRAM_CHAT = '-1004299449661';

// Canais a espelhar (os acessíveis pela conta 0xmindflayer, do diagnóstico).
// Você pode dar um telegramChatId próprio por canal (senão usa o TELEGRAM_CHAT).
const CHANNELS = [
  { name: 'chat', channelId: '1013855610871226480' },
  { name: 'beep-alpha', channelId: '1452022973568516330' },
  { name: 'melon-alpha', channelId: '1452022855255588946' },
  { name: 'ton-alpha', channelId: '1452023096046387240' },
];

const prisma = new PrismaClient();

(async () => {
  for (const c of CHANNELS) {
    const removed = await prisma.discordMonitor.deleteMany({
      where: { channelId: c.channelId },
    });
    await prisma.discordMonitor.create({
      data: {
        name: `Espelho ${c.name}`,
        channelId: c.channelId,
        pattern: null, // sem padrão = espelha tudo
        telegramChatId: c.telegramChatId || TELEGRAM_CHAT,
        waitForBotReply: false, // espelho: encaminha a mensagem como veio
        isActive: true,
      },
    });
    console.log(
      `✅ #${c.name} (${c.channelId}) → ${c.telegramChatId || TELEGRAM_CHAT}` +
        (removed.count ? `  (removidas ${removed.count} regra(s) antiga(s))` : ''),
    );
  }
  console.log(`\n${CHANNELS.length} canais configurados para ESPELHAR TUDO.`);
})()
  .catch((e) => {
    console.error('Erro:', e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
