import { Injectable } from '@nestjs/common';
import { Chain, ChainType } from '@prisma/client';
import { chainTypeOf } from '../../wallets/wallet-address.util';
import { MoralisProvider } from './moralis.provider';
import { HeliusSolanaProvider } from './helius-solana.provider';
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
 *  - SWAPS Solana → Helius (cobre Axiom/Meteora/pump.fun, que a Moralis não indexa);
 *  - SWAPS EVM   → Moralis (Wallet API);
 *  - OHLC e preço/snapshot de token → Moralis (bom e barato p/ esse uso).
 *
 * Fica atrás do token MARKET_DATA_PROVIDER — o resto do sistema (ingestão, PnL,
 * candles) não muda; só a origem dos swaps Solana passa a ser o Helius.
 */
@Injectable()
export class CompositeMarketDataProvider implements MarketDataProvider {
  constructor(
    private readonly moralis: MoralisProvider,
    private readonly helius: HeliusSolanaProvider,
  ) {}

  fetchSwaps(params: FetchSwapsParams): Promise<FetchSwapsResult> {
    return chainTypeOf(params.chain) === ChainType.SOLANA
      ? this.helius.fetchSwaps(params)
      : this.moralis.fetchSwaps(params);
  }

  fetchOhlc(params: FetchOhlcParams): Promise<OhlcCandle[]> {
    return this.moralis.fetchOhlc(params);
  }

  fetchTokenSnapshot(
    chain: Chain,
    mint: string,
  ): Promise<TokenSnapshot | null> {
    return this.moralis.fetchTokenSnapshot(chain, mint);
  }

  fetchTokenSnapshots(
    chain: Chain,
    mints: string[],
  ): Promise<Map<string, TokenSnapshot | null>> {
    return this.moralis.fetchTokenSnapshots(chain, mints);
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
}
