/* Pipeline completo (provider → motor de PnL) com dados REAIS. Uso: node scripts/pnl-live-test.js <wallet> [chain] */
const path = require('path');
const { HttpService } = require('@nestjs/axios');
const { MoralisProvider } = require(path.join(__dirname, '../dist/app/analytics/providers/moralis.provider.js'));
const { computePnl } = require(path.join(__dirname, '../dist/app/analytics/pnl-calculator.js'));

const ADDR = process.argv[2] || '4y96HLdkD6Bxt7YT8WwKBXoJ9R4sg4W6hjmLdR1ZuQXz';
const CHAIN = process.argv[3] || 'SOLANA';
const provider = new MoralisProvider({ get: (k) => process.env[k] }, new HttpService());

(async () => {
  // 1) Ingestão: pagina até 15 páginas (bound de teste).
  let cursor = null, page = 0;
  const swaps = [];
  do {
    const res = await provider.fetchSwaps({ chain: CHAIN, address: ADDR, cursor, limit: 100 });
    swaps.push(...res.swaps);
    cursor = res.nextCursor;
    page++;
  } while (cursor && page < 15);
  console.log(`Ingeridos ${swaps.length} swaps em ${page} página(s).`);

  // 2) Normaliza para TradeInput.
  const trades = swaps.map((s) => ({
    blockTime: new Date(s.blockTime), side: s.side, baseMint: s.baseMint, baseSymbol: s.baseSymbol,
    baseAmount: s.baseAmount, usdValue: s.usdValue, priceUsd: s.priceUsd, feeUsd: s.feeUsd || '0',
    priceResolved: s.priceResolved !== false,
  }));

  // 3) Motor de PnL — janela de 12 meses (BRT -180).
  const r = computePnl(trades, { windowStart: new Date(Date.now() - 365 * 864e5), tzOffsetMinutes: -180 });

  console.log('\n════════ RESULTADO (últimos 12 meses) ════════');
  console.log('Total de trades:', r.totalTrades, `(${r.buys} compras / ${r.sells} vendas)`);
  console.log('PnL de TRADING:  $', r.tradingPnlUsd, '  <- habilidade real (vendas casadas)');
  console.log('Windfall:        $', r.windfallProceedsUsd, '  <- proceeds de tokens sem base (airdrop/mint)');
  console.log('PnL bruto:       $', r.realizedPnlUsd, '  (trading + windfall)');
  console.log('PnL líquido:     $', r.netPnlUsd, `(trading - fees $${r.feesUsd})`);
  console.log('Volume:          $', r.volumeUsd, '| fee % vol:', r.feePctOfVolume);
  console.log('Hold médio winners:', r.avgHoldSecondsWinners, 's | losers:', r.avgHoldSecondsLosers, 's');
  console.log('Entradas totais: $', r.entrySizes.totalBuyUsd, '| média/entrada $', r.entrySizes.avgBuyUsd);
  console.log('Dias ativos:', r.perDay.activeDays, '| trades/dia:', r.perDay.avgTradesPerActiveDay, '| PnL/trade $', r.perDay.avgPnlPerTrade);
  console.log('Melhor dia:', JSON.stringify(r.perDay.bestDay), '\nPior dia:  ', JSON.stringify(r.perDay.worstDay));
  console.log('Trades após perda:', JSON.stringify(r.tradesAfterLoss));
  console.log('Confiança:', r.confidence.priceResolvedPct + '% preços resolvidos |', r.confidence.unmatchedSellCount, 'vendas sem lote');
  console.log('\nTop tokens por PnL:');
  for (const t of r.perToken.slice(0, 8)) {
    console.log(`  ${(t.symbol || t.mint.slice(0, 6)).padEnd(12)} PnL $${t.realizedPnlUsd.padStart(12)}  trades:${t.trades}  invest:$${t.buyUsd}  hold:${t.avgHoldSeconds ?? '-'}s`);
  }
  console.log('\nHoras mais ativas (fuso BRT):');
  const topHours = [...r.hourly].filter((h) => h.trades > 0).sort((a, b) => b.trades - a.trades).slice(0, 5);
  for (const h of topHours) console.log(`  ${String(h.hour).padStart(2, '0')}h → ${h.trades} trades, PnL $${h.realizedPnlUsd}`);
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
