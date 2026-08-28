-- CreateTable
CREATE TABLE "OnchainCache" (
    "key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OnchainCache_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "OnchainCache_fetchedAt_idx" ON "OnchainCache"("fetchedAt");

-- CreateIndex
CREATE INDEX "WalletScan_status_idx" ON "WalletScan"("status");
