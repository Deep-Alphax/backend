-- CreateTable
CREATE TABLE "TokenCandleCoverage" (
    "chain" "Chain" NOT NULL,
    "mint" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "fromTime" TIMESTAMP(3) NOT NULL,
    "toTime" TIMESTAMP(3) NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenCandleCoverage_pkey" PRIMARY KEY ("chain","mint","timeframe")
);
