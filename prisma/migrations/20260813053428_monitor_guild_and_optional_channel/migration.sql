-- AlterTable
ALTER TABLE "DiscordMonitor" ADD COLUMN     "guildId" TEXT,
ALTER COLUMN "channelId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "DiscordMonitor_guildId_idx" ON "DiscordMonitor"("guildId");
