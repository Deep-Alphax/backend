# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# Dockerfile de produção — NestJS 11 + Prisma 6 (Postgres) + Redis
# Multi-stage: build isolado, imagem final enxuta, roda como usuário não-root.
# Base Alpine casa com o binaryTarget do Prisma (linux-musl-openssl-3.0.x).
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: dependências (cache agressivo do install) ───────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
# openssl: exigido pelos query engines do Prisma em runtime/generate.
RUN apk add --no-cache openssl libc6-compat
# Corepack habilita o pnpm na versão travada pelo packageManager (se houver).
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
# Cache do store do pnpm entre builds (BuildKit).
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ── Stage 2: build (compila TS + gera Prisma Client) ─────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache openssl libc6-compat && corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Gera o client ANTES do build para que os tipos existam na compilação.
RUN pnpm exec prisma generate
RUN pnpm run build
# NÃO usamos `pnpm prune --prod` aqui de propósito: o CLI do Prisma (devDep) é
# necessário no runtime para `migrate deploy`. O ganho de imagem menor não
# compensa a fragilidade de reinstalar o CLI depois. node_modules segue completo.

# ── Stage 3: runner (imagem final) ───────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# Timezone e openssl para o Prisma. tini = init leve p/ sinais (SIGTERM) corretos.
RUN apk add --no-cache openssl libc6-compat tini && corepack enable

# node_modules vindos do build (inclui Prisma Client gerado + CLI do Prisma).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json ./
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# Segurança: nunca rodar como root. A imagem node já traz o usuário `node`.
USER node

EXPOSE 3333
# tini como PID 1 -> repassa sinais e evita processos zumbi.
ENTRYPOINT ["/sbin/tini", "--", "./docker-entrypoint.sh"]
CMD ["node", "dist/main"]
