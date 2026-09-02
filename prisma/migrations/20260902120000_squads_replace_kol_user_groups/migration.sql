-- Grupo/FnF e Squad eram o MESMO conceito em dois modelos: `KolPreset.squads`
-- (nomes livres, globais) e `KolUserGroup` (entidade por conta, referenciada
-- por id em `KolUserOverride.fnfGroups`). A rail acabava com duas facetas que
-- se combinavam em AND, e nenhuma delas sozinha respondia "em que squads este
-- KOL está". Passa a existir só `squads`: nomes, no preset e na conta.
--
-- A migração é feita em três passos para NÃO perder o que o usuário já marcou:
-- a coluna nova nasce, recebe os nomes dos grupos que cada override apontava, e
-- só então a antiga (e a tabela de grupos) somem.

-- 1. Coluna nova. Nullable de propósito: `NULL` = "o usuário não marcou squad
--    nenhum" e é distinto de `[]` = "marcou e depois tirou todos" — a mesma
--    convenção dos outros campos Json do override.
ALTER TABLE "KolUserOverride" ADD COLUMN "squads" JSONB;

-- 2. Traduz id -> nome. `jsonb_typeof = 'array'` protege as linhas cujo
--    `fnfGroups` é NULL ou não-array (nunca deveria acontecer, mas a coluna é
--    Json e um valor torto aqui abortaria a migration inteira). O JOIN por
--    `userId` garante que um id de grupo de OUTRA conta não vaze para esta.
UPDATE "KolUserOverride" o
SET "squads" = sub.names
FROM (
  SELECT o2."id",
         jsonb_agg(DISTINCT g."name") AS names
  FROM "KolUserOverride" o2
  CROSS JOIN LATERAL jsonb_array_elements_text(o2."fnfGroups") AS ref(group_id)
  JOIN "KolUserGroup" g
    ON g."id" = ref.group_id
   AND g."userId" = o2."userId"
  WHERE jsonb_typeof(o2."fnfGroups") = 'array'
  GROUP BY o2."id"
) sub
WHERE o."id" = sub."id";

-- 3. O modelo antigo sai. `KolUserGroup` só era referenciada por `fnfGroups`
--    (sem FK, a junção era feita no serviço), então não há constraint a soltar.
ALTER TABLE "KolUserOverride" DROP COLUMN "fnfGroups";
DROP TABLE "KolUserGroup";
