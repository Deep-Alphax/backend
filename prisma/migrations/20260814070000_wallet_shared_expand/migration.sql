-- Fase EXPAND: carteira vira CANÔNICA/compartilhada (1 registro por chain+addressNorm).
-- A relação usuário↔carteira migrou para WalletCatalog (ver 20260814060857_add_wallet_catalog
-- + script migrate-shared-wallets.js, que já deduplicou os dados). Aqui só re-chaveamos.
-- userId/kind/sourceId/label seguem presentes (opcionais) até a fase CONTRACT.

-- 1) userId opcional (carteiras compartilhadas não têm dono).
ALTER TABLE "Wallet" ALTER COLUMN "userId" DROP NOT NULL;

-- 2) Troca a unique per-user por unique GLOBAL por (chain, addressNorm).
DROP INDEX IF EXISTS "Wallet_userId_chain_addressNorm_key";
CREATE UNIQUE INDEX "Wallet_chain_addressNorm_key" ON "Wallet"("chain", "addressNorm");
