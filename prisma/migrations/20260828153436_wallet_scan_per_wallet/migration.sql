-- A varredura é de UMA carteira; a chave passa a ser (kolId, publicWallet).
-- Troca de PK sem perda: as linhas existentes já têm `publicWallet` preenchido.
ALTER TABLE "WalletScan" DROP CONSTRAINT "WalletScan_pkey";
ALTER TABLE "WalletScan" ADD CONSTRAINT "WalletScan_pkey" PRIMARY KEY ("kolId", "publicWallet");

-- CreateIndex
CREATE INDEX "WalletScan_kolId_idx" ON "WalletScan"("kolId");
