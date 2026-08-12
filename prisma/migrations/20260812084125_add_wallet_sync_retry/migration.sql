-- AlterTable
ALTER TABLE "Wallet" ADD COLUMN     "nextRetryAt" TIMESTAMP(3),
ADD COLUMN     "syncAttempts" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "Wallet_syncStatus_nextRetryAt_idx" ON "Wallet"("syncStatus", "nextRetryAt");
