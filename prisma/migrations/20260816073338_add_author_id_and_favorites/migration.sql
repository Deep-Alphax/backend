-- AlterTable
ALTER TABLE "CapturedMessage" ADD COLUMN     "authorId" TEXT;

-- CreateTable
CREATE TABLE "FavoriteAuthor" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorTag" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FavoriteAuthor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FavoriteAuthor_userId_idx" ON "FavoriteAuthor"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "FavoriteAuthor_userId_authorId_key" ON "FavoriteAuthor"("userId", "authorId");

-- CreateIndex
CREATE INDEX "CapturedMessage_authorId_createdAt_idx" ON "CapturedMessage"("authorId", "createdAt");

-- AddForeignKey
ALTER TABLE "FavoriteAuthor" ADD CONSTRAINT "FavoriteAuthor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
