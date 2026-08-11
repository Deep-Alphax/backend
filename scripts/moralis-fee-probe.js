/* Inspeciona TODOS os campos de um swap Solana da Moralis, procurando taxa/fee. */
const axios = require('axios');
const KEY = process.env.MORALIS_API_KEY;
const ADDR = process.argv[2] || '4y96HLdkD6Bxt7YT8WwKBXoJ9R4sg4W6hjmLdR1ZuQXz';

(async () => {
  const r = await axios.get(`https://solana-gateway.moralis.io/account/mainnet/${ADDR}/swaps`, {
    params: { limit: 3 },
    headers: { accept: 'application/json', 'X-API-Key': KEY },
  });
  const rows = r.data?.result || [];
  console.log('nº swaps:', rows.length, '\n');
  rows.forEach((s, i) => {
    console.log(`── swap ${i} (${s.transactionType}) ──`);
    console.log('top-level keys:', Object.keys(s).join(', '));
    // qualquer chave que cheire a fee/taxa/gas
    const feeish = Object.entries(s).filter(([k]) => /fee|gas|priorit|tax|cost/i.test(k));
    console.log('campos fee-ish:', feeish.length ? JSON.stringify(feeish) : 'NENHUM no top-level');
    console.log('bought keys:', Object.keys(s.bought || {}).join(', '));
    console.log('sold keys:', Object.keys(s.sold || {}).join(', '));
    console.log('');
  });
})().catch((e) => {
  console.error('ERRO', e.response?.status, JSON.stringify(e.response?.data)?.slice(0, 200) || e.message);
  process.exit(1);
});
