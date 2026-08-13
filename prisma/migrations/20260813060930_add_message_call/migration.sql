-- CreateTable
CREATE TABLE "MessageCall" (
    "id" TEXT NOT NULL,
    "capturedMessageId" TEXT NOT NULL,
    "chainType" "ChainType",
    "mint" TEXT,
    "ticker" TEXT,
    "guildName" TEXT,
    "channelId" TEXT NOT NULL,
    "calledAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessageCall_mint_calledAt_idx" ON "MessageCall"("mint", "calledAt");

-- CreateIndex
CREATE INDEX "MessageCall_ticker_calledAt_idx" ON "MessageCall"("ticker", "calledAt");

-- CreateIndex
CREATE INDEX "MessageCall_capturedMessageId_idx" ON "MessageCall"("capturedMessageId");

-- AddForeignKey
ALTER TABLE "MessageCall" ADD CONSTRAINT "MessageCall_capturedMessageId_fkey" FOREIGN KEY ("capturedMessageId") REFERENCES "CapturedMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
