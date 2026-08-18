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
      const read = this.prisma.getReadClient();
      const cached = await read.tokenCandle.findMany({
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

      // Sem candle no banco p/ esta janela. NEGATIVE CACHE: se já consultamos o
      // provider para uma janela que cobre [from,to] (mesmo tendo voltado vazio —
      // token morto/sem OHLCV), NÃO bate na API de novo. Candle histórico é imutável.
      const cov = await read.tokenCandleCoverage.findUnique({
        where: { chain_mint_timeframe: { chain, mint, timeframe } },
      });
      if (
        cov &&
        cov.fromTime.getTime() <= from.getTime() &&
        cov.toTime.getTime() >= to.getTime()
      ) {
        return []; // janela já buscada e sem dado → poupa a chamada
      }

      const fresh = await this.provider.fetchOhlc({ chain, mint, from, to, timeframe });
      await this.persist(chainType, chain, mint, timeframe, fresh);
      // Marca a janela como coberta MESMO se veio vazia (evita re-consultar token morto).
      await this.markCoverage(chain, mint, timeframe, from, to, cov);
      if (fresh.length === 0) return [];
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

  /**
   * Registra/expande a janela [fromTime, toTime] já consultada no provider para
   * (chain, mint, timeframe). União com a cobertura existente. Best-effort: falha
   * aqui só faz o negative cache não valer nessa rodada (re-consulta na próxima).
   */
  private async markCoverage(
    chain: Chain,
    mint: string,
    timeframe: string,
    from: Date,
    to: Date,
    existing: { fromTime: Date; toTime: Date } | null,
  ): Promise<void> {
    try {
      const fromTime = existing
        ? new Date(Math.min(existing.fromTime.getTime(), from.getTime()))
        : from;
      const toTime = existing
        ? new Date(Math.max(existing.toTime.getTime(), to.getTime()))
        : to;
      await this.prisma.getWriteClient().tokenCandleCoverage.upsert({
        where: { chain_mint_timeframe: { chain, mint, timeframe } },
        create: { chain, mint, timeframe, fromTime, toTime },
        update: { fromTime, toTime, fetchedAt: new Date() },
      });
    } catch (err: any) {
      this.logger.warn(`markCoverage ${mint} falhou: ${err?.message}`);
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
