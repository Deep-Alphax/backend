-- CreateTable
CREATE TABLE "WalletScan" (
    "kolId" TEXT NOT NULL,
    "kolName" TEXT NOT NULL,
    "scannedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "publicWallet" TEXT NOT NULL,
    "tokensAnalyzed" INTEGER NOT NULL DEFAULT 0,
    "apiCalls" INTEGER NOT NULL DEFAULT 0,
    "flagged" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletScan_pkey" PRIMARY KEY ("kolId")
);
