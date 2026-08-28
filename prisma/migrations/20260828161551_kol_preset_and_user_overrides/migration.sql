-- CreateTable
CREATE TABLE "KolPreset" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "wallets" JSONB NOT NULL DEFAULT '[]',
    "squads" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "relevance" INTEGER NOT NULL DEFAULT 20,
    "types" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "twitter" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "avatar" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KolPreset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KolUserOverride" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kolId" TEXT NOT NULL,
    "name" TEXT,
    "relevance" INTEGER,
    "types" JSONB,
    "fnfGroups" JSONB,
    "twitter" TEXT,
    "notes" TEXT,
    "avatar" TEXT,
    "walletsAdded" JSONB,
    "walletsRemoved" JSONB,
    "dismissedSidewallets" JSONB,
    "isCustom" BOOLEAN NOT NULL DEFAULT false,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KolUserOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KolUserGroup" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KolUserGroup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KolPreset_deletedAt_idx" ON "KolPreset"("deletedAt");

-- CreateIndex
CREATE INDEX "KolUserOverride_userId_idx" ON "KolUserOverride"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "KolUserOverride_userId_kolId_key" ON "KolUserOverride"("userId", "kolId");

-- CreateIndex
CREATE INDEX "KolUserGroup_userId_idx" ON "KolUserGroup"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "KolUserGroup_userId_name_key" ON "KolUserGroup"("userId", "name");

-- AddForeignKey
ALTER TABLE "KolUserOverride" ADD CONSTRAINT "KolUserOverride_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KolUserGroup" ADD CONSTRAINT "KolUserGroup_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
