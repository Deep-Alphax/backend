-- AlterTable
ALTER TABLE "FavoriteAuthor" ADD COLUMN     "color" TEXT,
ADD COLUMN     "nickname" TEXT,
ADD COLUMN     "photoData" BYTEA,
ADD COLUMN     "photoMime" TEXT,
ADD COLUMN     "photoUpdatedAt" TIMESTAMP(3);
