-- CreateTable
CREATE TABLE "BlacklistedUser" (
    "id" TEXT NOT NULL,
    "discordUserId" TEXT,
    "username" TEXT,
    "reason" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BlacklistedUser_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BlacklistedUser_isActive_idx" ON "BlacklistedUser"("isActive");
