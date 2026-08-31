-- A linha de FavoriteAuthor passa a existir por dois motivos independentes:
-- seguir o autor e/ou personalizá-lo. `followed=false` = só personalização
-- (apelido/cor/foto), que pinta os cards mas não entra no feed de favoritos.
-- Default true: toda linha existente hoje É um follow.
ALTER TABLE "FavoriteAuthor" ADD COLUMN "followed" BOOLEAN NOT NULL DEFAULT true;
