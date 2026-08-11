#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Entrypoint de produção.
# Aplica migrations pendentes (idempotente) e então executa o CMD (a app).
# `migrate deploy` NÃO gera migrations novas nem apaga dados — só aplica o que
# já está versionado em prisma/migrations. Seguro para rodar em todo boot.
# ─────────────────────────────────────────────────────────────────────────────
set -e

echo "[entrypoint] Aplicando migrations (prisma migrate deploy)..."
node_modules/.bin/prisma migrate deploy

echo "[entrypoint] Iniciando a aplicação..."
# exec: substitui o shell pelo processo do Node -> sinais (SIGTERM) chegam à app.
exec "$@"
