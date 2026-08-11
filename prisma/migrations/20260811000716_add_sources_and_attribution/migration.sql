-- CreateEnum
CREATE TYPE "WalletKind" AS ENUM ('OWN', 'SOURCE');

-- AlterTable
ALTER TABLE "Wallet" ADD COLUMN     "kind" "WalletKind" NOT NULL DEFAULT 'OWN',
ADD COLUMN     "sourceId" TEXT;

-- CreateTable
CREATE TABLE "Source" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "attributionWindowHours" INTEGER NOT NULL DEFAULT 6,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeAttribution" (
    "id" TEXT NOT NULL,
    "tradeId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "leadTradeId" TEXT NOT NULL,
    "leadWalletId" TEXT NOT NULL,
    "lagSeconds" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradeAttribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenCandle" (
    "id" TEXT NOT NULL,
    "chainType" "ChainType" NOT NULL,
    "chain" "Chain" NOT NULL,
    "mint" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "openTime" TIMESTAMP(3) NOT NULL,
    "open" DECIMAL(38,18) NOT NULL,
    "high" DECIMAL(38,18) NOT NULL,
    "low" DECIMAL(38,18) NOT NULL,
    "close" DECIMAL(38,18) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenCandle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Source_userId_idx" ON "Source"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Source_userId_name_key" ON "Source"("userId", "name");

-- CreateIndex
CREATE INDEX "TradeAttribution_sourceId_idx" ON "TradeAttribution"("sourceId");

-- CreateIndex
CREATE INDEX "TradeAttribution_tradeId_idx" ON "TradeAttribution"("tradeId");

-- CreateIndex
CREATE UNIQUE INDEX "TradeAttribution_tradeId_sourceId_key" ON "TradeAttribution"("tradeId", "sourceId");

-- CreateIndex
CREATE INDEX "TokenCandle_chain_mint_timeframe_openTime_idx" ON "TokenCandle"("chain", "mint", "timeframe", "openTime");

-- CreateIndex
CREATE UNIQUE INDEX "TokenCandle_chain_mint_timeframe_openTime_key" ON "TokenCandle"("chain", "mint", "timeframe", "openTime");

-- CreateIndex
CREATE INDEX "Wallet_sourceId_idx" ON "Wallet"("sourceId");

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Source" ADD CONSTRAINT "Source_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeAttribution" ADD CONSTRAINT "TradeAttribution_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "Trade"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeAttribution" ADD CONSTRAINT "TradeAttribution_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;
