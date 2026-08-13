/**
 * Define a role de um usuário pelo email — direto no banco (bootstrap de admin).
 * Não precisa de sessão/auth: fala com o Postgres via Prisma (usa o DATABASE_URL
 * do .env, carregado automaticamente pelo Prisma Client).
 *
 * Uso:
 *   node scripts/set-role.js <email> [ADMIN|USER]
 * Exemplos:
 *   node scripts/set-role.js eu@deepalpha.dev ADMIN
 *   node scripts/set-role.js alguem@x.com USER
 */
const { PrismaClient } = require('@prisma/client');

const email = process.argv[2];
const role = (process.argv[3] || 'ADMIN').toUpperCase();

if (!email) {
  console.error('Uso: node scripts/set-role.js <email> [ADMIN|USER]');
  process.exit(1);
}
if (!['ADMIN', 'USER'].includes(role)) {
  console.error(`Role inválida: "${role}". Use ADMIN ou USER.`);
  process.exit(1);
}

const prisma = new PrismaClient();

(async () => {
  const user = await prisma.user.findFirst({
    where: { email: { equals: email.trim(), mode: 'insensitive' } },
    select: { id: true, email: true, role: true },
  });

  if (!user) {
    console.error(`❌ Usuário não encontrado: ${email}`);
    process.exit(1);
  }
  if (user.role === role) {
    console.log(`ℹ️  ${user.email} já é ${role}. Nada a fazer.`);
    return;
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { role },
    select: { email: true, role: true },
  });
  console.log(`✅ ${updated.email} → ${updated.role}`);
})()
  .catch((e) => {
    console.error('Erro:', e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
