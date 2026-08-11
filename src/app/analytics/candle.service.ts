import { Inject, Injectable, Logger } from '@nestjs/common';
import { Chain, ChainType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  MARKET_DATA_PROVIDER,
  MarketDataProvider,
  OhlcTimeframe,
} from './providers/market-data-provider.interface';

/** Candle reduzido consumido pelo engine (high p/ pico, close p/ benchmark). */
export interface CandleFull {
  timeMs: number;
  high: number;
  close: number;
}

/**
 * Cache de candles OHLC (Bloco 2). Lê do banco (`TokenCandle`); em falta, busca
 * no provider e persiste (evita refazer chamadas → custo/rate-limit). Best-effort:
 * qualquer erro vira `[]`, para nunca derrubar o cálculo das métricas.
 */
@Injectable()
export class CandleService {
  private readonly logger = new Logger(CandleService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MARKET_DATA_PROVIDER) private readonly provider: MarketDataProvider,
  ) {}

  async getCandles(
    chainType: ChainType,
    chain: Chain,
    mint: string,
    from: Date,
    to: Date,
    timeframe: OhlcTimeframe = '1h',
  ): Promise<CandleFull[]> {
    try {
      const cached = await this.prisma.getReadClient().tokenCandle.findMany({
        where: { chain, mint, timeframe, openTime: { gte: from, lte: to } },
        orderBy: { openTime: 'asc' },
        select: { openTime: true, high: true, close: true },
      });
      if (cached.length > 0) {
        return cached.map((c) => ({
          timeMs: c.openTime.getTime(),
          high: Number(c.high),
          close: Number(c.close),
        }));
      }

      const fresh = await this.provider.fetchOhlc({ chain, mint, from, to, timeframe });
      if (fresh.length === 0) return [];
      await this.persist(chainType, chain, mint, timeframe, fresh);
      return fresh.map((c) => ({
        timeMs: c.openTime.getTime(),
        high: Number(c.high),
        close: Number(c.close),
      }));
    } catch (err: any) {
      this.logger.warn(`getCandles ${mint} falhou: ${err?.message}`);
      return [];
    }
  }

  private async persist(
    chainType: ChainType,
    chain: Chain,
    mint: string,
    timeframe: OhlcTimeframe,
    candles: { openTime: Date; open: string; high: string; low: string; close: string }[],
  ): Promise<void> {
    try {
      await this.prisma.getWriteClient().tokenCandle.createMany({
        data: candles.map((c) => ({
          chainType,
          chain,
          mint,
          timeframe,
          openTime: c.openTime,
          open: new Prisma.Decimal(c.open),
          high: new Prisma.Decimal(c.high),
          low: new Prisma.Decimal(c.low),
          close: new Prisma.Decimal(c.close),
        })),
        skipDuplicates: true, // idempotente pela unique (chain,mint,tf,openTime)
      });
    } catch (err: any) {
      this.logger.warn(`persist candles ${mint} falhou: ${err?.message}`);
    }
  }
}
