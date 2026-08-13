/**
 * Testa o envio ao Telegram ISOLADO (sem Discord). Verifica: token válido + o bot
 * consegue postar no chat/canal. Lê `TELEGRAM_BOT_TOKEN` do process.env ou do .env.
 *
 * Uso:  node scripts/telegram-test.js <chat_id> ["mensagem opcional"]
 * Ex.:  node scripts/telegram-test.js -1004299449661 "teste 123"
 */
const fs = require('fs');
const path = require('path');

/** Remove aspas simples/duplas nas pontas (o dotenv do runtime faz isso; aqui replicamos). */
function stripQuotes(v) {
  return v.replace(/^\s*["']|["']\s*$/g, '').trim();
}

function loadToken() {
  if (process.env.TELEGRAM_BOT_TOKEN) return stripQuotes(process.env.TELEGRAM_BOT_TOKEN);
  try {
    const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    const m = env.match(/^\s*TELEGRAM_BOT_TOKEN\s*=\s*(.+)\s*$/m);
    return m ? stripQuotes(m[1]) : '';
  } catch {
    return '';
  }
}

const token = loadToken();
const chatId = process.argv[2];
const text = process.argv[3] || '✅ Deep Alpha → Telegram: teste OK';

if (!token) {
  console.error('❌ TELEGRAM_BOT_TOKEN não encontrado (preencha no .env do backend).');
  process.exit(1);
}
if (!chatId) {
  console.error('Uso: node scripts/telegram-test.js <chat_id> ["mensagem"]');
  process.exit(1);
}

(async () => {
  // 1) Sanidade do token: quem é o bot?
  const meRes = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const me = await meRes.json();
  if (!me.ok) {
    console.error('❌ Token inválido (getMe falhou):', me.error_code, me.description);
    process.exit(1);
  }
  console.log(`🤖 Bot: @${me.result.username} (${me.result.first_name})`);

  // 2) Tenta enviar a mensagem ao chat.
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  const j = await res.json();

  if (j.ok) {
    console.log(`✅ Enviado ao chat ${chatId} (message_id ${j.result.message_id}).`);
  } else {
    console.error(`❌ Telegram recusou: ${j.error_code} — ${j.description}`);
    if (/chat not found/i.test(j.description || '')) {
      console.error('   → Adicione o bot ao canal/grupo (e, em canal, torne-o ADMIN com permissão de postar).');
    }
    if (/bot was kicked|not a member/i.test(j.description || '')) {
      console.error('   → O bot não está mais no chat. Readicione-o.');
    }
    process.exit(1);
  }
})().catch((e) => {
  console.error('Erro de rede:', e.message);
  process.exit(1);
});
