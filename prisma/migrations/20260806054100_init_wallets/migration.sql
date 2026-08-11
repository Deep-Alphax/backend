-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "ChainType" AS ENUM ('EVM', 'SOLANA');

-- CreateEnum
CREATE TYPE "Chain" AS ENUM ('SOLANA', 'ETHEREUM', 'BASE', 'ARBITRUM', 'BSC', 'POLYGON', 'OPTIMISM');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('PENDING', 'SYNCING', 'SYNCED', 'ERROR');

-- CreateEnum
CREATE TYPE "TradeSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "MetricScope" AS ENUM ('WALLET', 'PORTFOLIO');

-- CreateEnum
CREATE TYPE "MetricPeriod" AS ENUM ('D30', 'D90', 'M12');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT,
    "firstName" TEXT NOT NULL DEFAULT '',
    "lastName" TEXT NOT NULL DEFAULT '',
    "avatarUrl" TEXT,
    "googleId" TEXT,
    "googleEmail" TEXT,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "passwordChangedAt" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "language" TEXT NOT NULL DEFAULT 'EN',
    "acceptedTerms" BOOLEAN NOT NULL DEFAULT false,
    "acceptedPrivacyPolicy" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "addressNorm" TEXT NOT NULL,
    "chainType" "ChainType" NOT NULL,
    "chain" "Chain" NOT NULL,
    "label" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "syncStatus" "SyncStatus" NOT NULL DEFAULT 'PENDING',
    "syncCursor" TEXT,
    "syncError" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "firstTxAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "chainType" "ChainType" NOT NULL,
    "txHash" TEXT NOT NULL,
    "blockTime" TIMESTAMP(3) NOT NULL,
    "side" "TradeSide" NOT NULL,
    "baseMint" TEXT NOT NULL,
    "baseSymbol" TEXT,
    "baseAmount" DECIMAL(38,18) NOT NULL,
    "quoteMint" TEXT NOT NULL,
    "quoteSymbol" TEXT,
    "quoteAmount" DECIMAL(38,18) NOT NULL,
    "usdValue" DECIMAL(38,12) NOT NULL,
    "priceUsd" DECIMAL(38,18) NOT NULL,
    "feeUsd" DECIMAL(38,12) NOT NULL DEFAULT 0,
    "feeNative" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "priceResolved" BOOLEAN NOT NULL DEFAULT true,
    "dexProgram" TEXT,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenPosition" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "symbol" TEXT,
    "qtyHeld" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "avgCostUsd" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "realizedPnl" DECIMAL(38,12) NOT NULL DEFAULT 0,
    "feesUsd" DECIMAL(38,12) NOT NULL DEFAULT 0,
    "buyCount" INTEGER NOT NULL DEFAULT 0,
    "sellCount" INTEGER NOT NULL DEFAULT 0,
    "firstBuyAt" TIMESTAMP(3),
    "lastTradeAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TokenPosition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetricSnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "walletId" TEXT,
    "scope" "MetricScope" NOT NULL,
    "period" "MetricPeriod" NOT NULL,
    "data" JSONB NOT NULL,
    "tradesHash" TEXT NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetricSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");

-- CreateIndex
CREATE INDEX "User_googleId_idx" ON "User"("googleId");

-- CreateIndex
CREATE INDEX "User_deletedAt_idx" ON "User"("deletedAt");

-- CreateIndex
CREATE INDEX "Wallet_userId_idx" ON "Wallet"("userId");

-- CreateIndex
CREATE INDEX "Wallet_syncStatus_idx" ON "Wallet"("syncStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_userId_chain_addressNorm_key" ON "Wallet"("userId", "chain", "addressNorm");

-- CreateIndex
CREATE INDEX "Trade_walletId_blockTime_idx" ON "Trade"("walletId", "blockTime");

-- CreateIndex
CREATE INDEX "Trade_walletId_baseMint_blockTime_idx" ON "Trade"("walletId", "baseMint", "blockTime");

-- CreateIndex
CREATE UNIQUE INDEX "Trade_walletId_txHash_baseMint_side_key" ON "Trade"("walletId", "txHash", "baseMint", "side");

-- CreateIndex
CREATE INDEX "TokenPosition_walletId_idx" ON "TokenPosition"("walletId");

-- CreateIndex
CREATE UNIQUE INDEX "TokenPosition_walletId_mint_key" ON "TokenPosition"("walletId", "mint");

-- CreateIndex
CREATE INDEX "MetricSnapshot_userId_idx" ON "MetricSnapshot"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "MetricSnapshot_userId_walletId_scope_period_key" ON "MetricSnapshot"("userId", "walletId", "scope", "period");

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenPosition" ADD CONSTRAINT "TokenPosition_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetricSnapshot" ADD CONSTRAINT "MetricSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetricSnapshot" ADD CONSTRAINT "MetricSnapshot_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
