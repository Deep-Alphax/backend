/**
 * Diagnóstico do self-bot: loga com o DISCORD_USER_TOKEN, mostra a conta, checa se
 * ela CONSEGUE VER cada canal monitorado (regras ativas no banco) e escuta as
 * mensagens desses canais ao vivo por alguns segundos.
 *
 * Uso:  node scripts/discord-test.js
 * Dica: rode e, de OUTRA conta, poste algo num canal monitorado para ver chegar.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('discord.js-selfbot-v13');
const { PrismaClient } = require('@prisma/client');

const WATCH_SECONDS = 30;

function stripQuotes(v) {
  return v.replace(/^\s*["']|["']\s*$/g, '').trim();
}
function loadToken() {
  if (process.env.DISCORD_USER_TOKEN) return stripQuotes(process.env.DISCORD_USER_TOKEN);
  try {
    const e = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    const m = e.match(/^\s*DISCORD_USER_TOKEN\s*=\s*(.+)\s*$/m);
    return m ? stripQuotes(m[1]) : '';
  } catch {
    return '';
  }
}

const token = loadToken();
if (!token) {
  console.error('❌ DISCORD_USER_TOKEN ausente no .env');
  process.exit(1);
}

const prisma = new PrismaClient();
const client = new Client({ checkUpdate: false });

(async () => {
  const monitors = await prisma.discordMonitor.findMany({ where: { isActive: true } });
  const channelIds = [...new Set(monitors.map((m) => m.channelId))];
  console.log(`Regras ativas: ${monitors.length} em ${channelIds.length} canais.`);

  client.on('ready', async () => {
    console.log(`\n✅ Logado como ${client.user.tag} (id ${client.user.id})`);
    console.log(`Servidores que a conta enxerga: ${client.guilds.cache.size}`);
    console.log('\n— Acesso aos canais monitorados —');
    for (const id of channelIds) {
      try {
        const ch = await client.channels.fetch(id);
        if (ch) console.log(`  ✅ ${id} → #${ch.name ?? '?'} (${ch.guild?.name ?? 'DM'})`);
        else console.log(`  ❌ ${id} → não encontrado`);
      } catch (e) {
        console.log(`  ❌ ${id} → SEM ACESSO (${e.message}) — a conta está nesse servidor?`);
      }
    }
    console.log(`\n👂 Ouvindo por ${WATCH_SECONDS}s… poste algo de OUTRA conta num canal monitorado.`);
  });

  client.on('messageCreate', (msg) => {
    if (!channelIds.includes(String(msg.channel?.id))) return;
    const own = msg.author?.id === client.user?.id ? '  ⚠️ SUA MENSAGEM (seria IGNORADA)' : '';
    const text = (msg.content || msg.embeds?.[0]?.description || '')
      .slice(0, 80)
      .replace(/\n/g, ' ');
    console.log(`  📩 #${msg.channel?.name} ${msg.author?.tag}: "${text}"${own}`);
  });

  client.on('error', (e) => console.log('Discord error:', e.message));

  await client.login(token);

  setTimeout(async () => {
    console.log('\n⏱️  Fim do teste.');
    try {
      await client.destroy();
    } catch {
      /* ignore */
    }
    await prisma.$disconnect();
    process.exit(0);
  }, (WATCH_SECONDS + 4) * 1000);
})().catch((e) => {
  console.error('Erro:', e.message);
  process.exit(1);
});
