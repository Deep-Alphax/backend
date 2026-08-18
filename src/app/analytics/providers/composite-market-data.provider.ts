import { Injectable } from '@nestjs/common';
import { Chain, ChainType, SwapSource } from '@prisma/client';
import { chainTypeOf } from '../../wallets/wallet-address.util';
import { MoralisProvider } from './moralis.provider';
import { HeliusSolanaProvider } from './helius-solana.provider';
import { BirdeyeSolanaProvider } from './birdeye-solana.provider';
import {
  MarketDataProvider,
  FetchSwapsParams,
  FetchSwapsResult,
  FetchOhlcParams,
  OhlcCandle,
  TokenSnapshot,
} from './market-data-provider.interface';

/**
 * Provider composto: escolhe a MELHOR fonte por capacidade/chain.
 *  - SWAPS Solana → Birdeye (trades dedicados, USD real, rápido) se BIRDEYE_API_KEY;
 *                   senão Helius (reconstrução por delta) como fallback;
 *  - SWAPS EVM   → Moralis (Wallet API);
 *  - SNAPSHOT (preço/liquidez) Solana → Helius (DexScreener, sem Moralis); EVM → Moralis;
 *  - OHLC de token → Moralis.
 *
 * Fica atrás do token MARKET_DATA_PROVIDER — o resto do sistema (ingestão, PnL,
 * candles) não muda; só a origem dos swaps Solana passa a ser o Helius.
 */
@Injectable()
export class CompositeMarketDataProvider implements MarketDataProvider {
  constructor(
    private readonly moralis: MoralisProvider,
    private readonly helius: HeliusSolanaProvider,
    private readonly birdeye: BirdeyeSolanaProvider,
  ) {}

  fetchSwaps(params: FetchSwapsParams): Promise<FetchSwapsResult> {
    // Fonte PINADA (por carteira) tem prioridade absoluta — nunca mistura fontes.
    switch (params.source) {
      case SwapSource.BIRDEYE:
        return this.birdeye.fetchSwaps(params);
      case SwapSource.HELIUS:
        return this.helius.fetchSwaps(params);
      case SwapSource.MORALIS:
        return this.moralis.fetchSwaps(params);
    }
    // Sem pin → default por chain (compat): EVM→Moralis; Solana→Birdeye|Helius.
    if (chainTypeOf(params.chain) !== ChainType.SOLANA) {
      return this.moralis.fetchSwaps(params);
    }
    return this.birdeye.isEnabled()
      ? this.birdeye.fetchSwaps(params)
      : this.helius.fetchSwaps(params);
  }

  fetchOhlc(params: FetchOhlcParams): Promise<OhlcCandle[]> {
    // Solana → Birdeye (cobre memecoin/bonding-curve, que a Moralis não indexa);
    // sem key → Moralis. EVM → Moralis.
    return chainTypeOf(params.chain) === ChainType.SOLANA && this.birdeye.isEnabled()
      ? this.birdeye.fetchOhlc(params)
      : this.moralis.fetchOhlc(params);
  }

  /** Snapshot de token: Solana → Helius (DexScreener, sem Moralis); EVM → Moralis. */
  fetchTokenSnapshot(
    chain: Chain,
    mint: string,
  ): Promise<TokenSnapshot | null> {
    return chainTypeOf(chain) === ChainType.SOLANA
      ? this.helius.fetchTokenSnapshot(chain, mint)
      : this.moralis.fetchTokenSnapshot(chain, mint);
  }

  fetchTokenSnapshots(
    chain: Chain,
    mints: string[],
  ): Promise<Map<string, TokenSnapshot | null>> {
    return chainTypeOf(chain) === ChainType.SOLANA
      ? this.helius.fetchTokenSnapshots(chain, mints)
      : this.moralis.fetchTokenSnapshots(chain, mints);
  }

  /**
   * Saldo USD atual: Solana → Helius (RPC + DexScreener, SEM Moralis) para minimizar
   * o uso da Moralis; EVM → Moralis (net-worth).
   */
  fetchWalletBalanceUsd(chain: Chain, address: string): Promise<string | null> {
    return chainTypeOf(chain) === ChainType.SOLANA
      ? this.helius.fetchWalletBalanceUsd(chain, address)
      : this.moralis.fetchWalletBalanceUsd(chain, address);
  }

  /** Holdings on-chain reais: Solana → Helius (RPC). EVM → indisponível por ora ([]). */
  fetchWalletHoldings(
    chain: Chain,
    address: string,
  ): Promise<Array<{ mint: string; qty: string }>> {
    return chainTypeOf(chain) === ChainType.SOLANA
      ? this.helius.fetchWalletHoldings(chain, address)
      : Promise.resolve([]);
  }
}
