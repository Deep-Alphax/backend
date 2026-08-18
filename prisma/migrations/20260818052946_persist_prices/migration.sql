-- CreateTable
CREATE TABLE "TokenPrice" (
    "chain" "Chain" NOT NULL,
    "mint" TEXT NOT NULL,
    "priceUsd" DECIMAL(38,18),
    "liquidityUsd" DECIMAL(38,2),
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenPrice_pkey" PRIMARY KEY ("chain","mint")
);

-- CreateTable
CREATE TABLE "SolDayPrice" (
    "day" TEXT NOT NULL,
    "priceUsd" DECIMAL(38,18) NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SolDayPrice_pkey" PRIMARY KEY ("day")
);

-- CreateIndex
CREATE INDEX "TokenPrice_fetchedAt_idx" ON "TokenPrice"("fetchedAt");
