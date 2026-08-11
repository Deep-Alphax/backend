/* Sonda endpoints candidatos da Moralis p/ TRANSFERS (Solana + EVM) e verifica se há USD. */
const axios = require('axios');
const KEY = process.env.MORALIS_API_KEY;
const SOL = '4y96HLdkD6Bxt7YT8WwKBXoJ9R4sg4W6hjmLdR1ZuQXz';
const SOL_BASE = 'https://solana-gateway.moralis.io';

async function probe(label, url, params) {
  try {
    const r = await axios.get(url, {
      params,
      headers: { accept: 'application/json', 'X-API-Key': KEY },
      timeout: 15000,
    });
    const data = r.data;
    const arr = Array.isArray(data?.result) ? data.result : Array.isArray(data) ? data : null;
    console.log(`\n✅ ${label} [${r.status}] ${arr ? arr.length + ' itens' : 'obj'}`);
    const sample = arr ? arr[0] : data;
    if (sample) console.log('  keys:', Object.keys(sample).join(', '));
    if (sample) console.log('  sample:', JSON.stringify(sample).slice(0, 600));
  } catch (e) {
    console.log(`\n❌ ${label} [${e.response?.status}] ${JSON.stringify(e.response?.data)?.slice(0, 160) || e.message}`);
  }
}

(async () => {
  // Candidatos Solana Gateway
  await probe('SOL /transfers', `${SOL_BASE}/account/mainnet/${SOL}/transfers`, { limit: 3 });
  await probe('SOL /portfolio', `${SOL_BASE}/account/mainnet/${SOL}/portfolio`, {});
  await probe('SOL /tokens', `${SOL_BASE}/account/mainnet/${SOL}/tokens`, {});
  // history/enriquecido?
  await probe('SOL /history', `${SOL_BASE}/account/mainnet/${SOL}/history`, { limit: 3 });
})();
