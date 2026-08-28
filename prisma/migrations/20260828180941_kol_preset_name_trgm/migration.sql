-- `gin_trgm_ops` vem da extensão pg_trgm; sem ela o CREATE INDEX abaixo falha.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateIndex
CREATE INDEX "KolPreset_name_idx" ON "KolPreset" USING GIN ("name" gin_trgm_ops);
