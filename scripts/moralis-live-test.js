/* Testa o MoralisProvider contra a API real. Uso: node scripts/moralis-live-test.js <wallet> [chain] */
const path = require('path');
const { HttpService } = require('@nestjs/axios');
const { MoralisProvider } = require(path.join(__dirname, '../dist/app/analytics/providers/moralis.provider.js'));

const ADDR = process.argv[2] || '4y96HLdkD6Bxt7YT8WwKBXoJ9R4sg4W6hjmLdR1ZuQXz';
const CHAIN = process.argv[3] || 'SOLANA';
const cfg = { get: (k) => process.env[k] };
const provider = new MoralisProvider(cfg, new HttpService());

(async () => {
  console.log(`Consultando swaps ${CHAIN} para ${ADDR}\n`);
  const res = await provider.fetchSwaps({ chain: CHAIN, address: ADDR, limit: 10 });
  console.log('swaps recebidos:', res.swaps.length, '| nextCursor:', res.nextCursor ? '(há mais)' : null, '\n');
  const sample = res.swaps.slice(0, 3).map((s) => ({
    side: s.side, baseSymbol: s.baseSymbol, baseMint: s.baseMint, baseAmount: s.baseAmount,
    quoteSymbol: s.quoteSymbol, usdValue: s.usdValue, priceUsd: s.priceUsd,
    priceResolved: s.priceResolved, blockTime: s.blockTime, dex: s.dexProgram,
  }));
  console.log('amostra normalizada:', JSON.stringify(sample, null, 2));

  const suspeito = res.swaps.length > 0 && res.swaps.every((s) => !s.baseMint || s.usdValue === '0');
  if (suspeito) console.log('\n⚠️  base/usd vazios — shape do JSON difere do mapeador.');
  if (res.swaps[0]) console.log('\nRAW da 1ª entrada:\n', JSON.stringify(res.swaps[0].raw, null, 2).slice(0, 1800));
})().catch((e) => {
  console.error('ERRO:', e.message);
  if (e.response) console.error('status', e.response.status, JSON.stringify(e.response.data).slice(0, 400));
  process.exit(1);
});
