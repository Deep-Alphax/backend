-- CreateEnum
CREATE TYPE "SwapSource" AS ENUM ('BIRDEYE', 'HELIUS', 'MORALIS');

-- AlterTable
ALTER TABLE "Wallet" ADD COLUMN     "syncSource" "SwapSource";
