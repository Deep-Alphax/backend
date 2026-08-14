-- CreateEnum
CREATE TYPE "CatalogRole" AS ENUM ('TRACKED', 'SOURCE');

-- CreateTable
CREATE TABLE "WalletCatalog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "role" "CatalogRole" NOT NULL DEFAULT 'TRACKED',
    "label" TEXT,
    "sourceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletCatalog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WalletCatalog_userId_idx" ON "WalletCatalog"("userId");

-- CreateIndex
CREATE INDEX "WalletCatalog_walletId_idx" ON "WalletCatalog"("walletId");

-- CreateIndex
CREATE INDEX "WalletCatalog_sourceId_idx" ON "WalletCatalog"("sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletCatalog_userId_walletId_key" ON "WalletCatalog"("userId", "walletId");

-- AddForeignKey
ALTER TABLE "WalletCatalog" ADD CONSTRAINT "WalletCatalog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletCatalog" ADD CONSTRAINT "WalletCatalog_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletCatalog" ADD CONSTRAINT "WalletCatalog_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE SET NULL ON UPDATE CASCADE;
