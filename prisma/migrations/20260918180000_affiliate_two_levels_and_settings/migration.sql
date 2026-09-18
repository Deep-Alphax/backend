-- DropIndex
DROP INDEX "public"."ReferralCommission_providerInvoiceId_key";

-- AlterTable
ALTER TABLE "ReferralCommission" ADD COLUMN     "level" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "affiliateLevel1Bps" INTEGER,
ADD COLUMN     "affiliateLevel2Bps" INTEGER;

-- CreateTable
CREATE TABLE "AffiliateSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "level1Bps" INTEGER NOT NULL DEFAULT 2000,
    "level2Bps" INTEGER NOT NULL DEFAULT 500,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AffiliateSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReferralCommission_providerInvoiceId_level_key" ON "ReferralCommission"("providerInvoiceId", "level");

