-- Grupo liberado para o plano FREE. Default false: todo grupo existente
-- continua PRO até o admin marcar — nada vaza por padrão.

-- AlterTable
ALTER TABLE "DiscordMonitor" ADD COLUMN     "freeTier" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "DiscordMonitor_freeTier_idx" ON "DiscordMonitor"("freeTier");
