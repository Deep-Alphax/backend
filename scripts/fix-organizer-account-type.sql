-- Corrige usuários que são OWNER de organização mas têm accountType = 'USER'.
-- Necessário para o login como organizador (POST /api/v1/auth/login/organizer) funcionar.
-- Executar uma vez na VPS após deploy da correção de accountType.

BEGIN;

UPDATE "User"
SET "accountType" = 'ORGANIZER'
WHERE id IN (
  SELECT "userId" FROM "OrganizationMember" WHERE role = 'OWNER'
)
AND "accountType" = 'USER';

-- Ver quantas linhas foram afetadas (opcional)
-- SELECT COUNT(*) FROM "User" WHERE "accountType" = 'ORGANIZER';

COMMIT;
