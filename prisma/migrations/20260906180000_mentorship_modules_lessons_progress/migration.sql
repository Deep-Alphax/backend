-- Mentoria: trilhas, aulas e progresso por usuário.
-- Puramente ADITIVO: cria um enum e três tabelas novas, sem tocar em nada que
-- já existe. Não há backfill nem lock em tabela grande — só a FK para "User",
-- que valida uma tabela vazia (custo zero).

-- CreateEnum
CREATE TYPE "MentorshipAccent" AS ENUM ('PRINCIPAL', 'GREEN', 'AZUL', 'VIOLETA');

-- CreateTable
CREATE TABLE "MentorshipModule" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT NOT NULL DEFAULT '',
    "label" TEXT NOT NULL DEFAULT '',
    "coverUrl" TEXT NOT NULL DEFAULT '',
    "accent" "MentorshipAccent" NOT NULL DEFAULT 'PRINCIPAL',
    "position" INTEGER NOT NULL DEFAULT 0,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MentorshipModule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MentorshipLesson" (
    "id" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "episode" INTEGER NOT NULL DEFAULT 1,
    "durationSec" INTEGER NOT NULL DEFAULT 0,
    "coverUrl" TEXT NOT NULL DEFAULT '',
    "videoUrl" TEXT NOT NULL DEFAULT '',
    "position" INTEGER NOT NULL DEFAULT 0,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MentorshipLesson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LessonProgress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "positionSec" INTEGER NOT NULL DEFAULT 0,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LessonProgress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MentorshipModule_slug_key" ON "MentorshipModule"("slug");

-- CreateIndex
CREATE INDEX "MentorshipModule_published_position_idx" ON "MentorshipModule"("published", "position");

-- CreateIndex
CREATE INDEX "MentorshipLesson_moduleId_position_idx" ON "MentorshipLesson"("moduleId", "position");

-- CreateIndex
CREATE INDEX "LessonProgress_userId_updatedAt_idx" ON "LessonProgress"("userId", "updatedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "LessonProgress_userId_lessonId_key" ON "LessonProgress"("userId", "lessonId");

-- AddForeignKey
ALTER TABLE "MentorshipLesson" ADD CONSTRAINT "MentorshipLesson_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "MentorshipModule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonProgress" ADD CONSTRAINT "LessonProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonProgress" ADD CONSTRAINT "LessonProgress_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "MentorshipLesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;
