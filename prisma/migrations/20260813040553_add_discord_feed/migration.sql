-- CreateTable
CREATE TABLE "DiscordMonitor" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "channelId" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "telegramChatId" TEXT NOT NULL,
    "waitForBotReply" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscordMonitor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CapturedMessage" (
    "id" TEXT NOT NULL,
    "monitorId" TEXT,
    "guildName" TEXT,
    "channelId" TEXT NOT NULL,
    "channelName" TEXT,
    "authorTag" TEXT,
    "matchedPattern" TEXT,
    "discordMessageId" TEXT,
    "text" TEXT NOT NULL,
    "embed" JSONB,
    "links" TEXT[],
    "sentToTelegram" BOOLEAN NOT NULL DEFAULT false,
    "telegramError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CapturedMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DiscordMonitor_channelId_idx" ON "DiscordMonitor"("channelId");

-- CreateIndex
CREATE INDEX "DiscordMonitor_isActive_idx" ON "DiscordMonitor"("isActive");

-- CreateIndex
CREATE INDEX "CapturedMessage_channelId_idx" ON "CapturedMessage"("channelId");

-- CreateIndex
CREATE INDEX "CapturedMessage_monitorId_idx" ON "CapturedMessage"("monitorId");

-- CreateIndex
CREATE INDEX "CapturedMessage_createdAt_idx" ON "CapturedMessage"("createdAt");

-- AddForeignKey
ALTER TABLE "CapturedMessage" ADD CONSTRAINT "CapturedMessage_monitorId_fkey" FOREIGN KEY ("monitorId") REFERENCES "DiscordMonitor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
