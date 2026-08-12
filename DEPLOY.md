# Deploy do Backend (Deep Alpha) com Docker na VPS

Guia de deploy de produção. Datas absolutas (YYYY-MM-DD). Criado em 2026-08-11.

## Arquivos envolvidos

| Arquivo | Função |
|---|---|
| `Dockerfile` | Build multi-stage (Node 22 Alpine), gera Prisma Client, roda como usuário **não-root**, usa `tini` p/ sinais corretos |
| `docker-entrypoint.sh` | Aplica `prisma migrate deploy` (idempotente) antes de subir a app |
| `docker-compose.prod.yml` | Sobe **app + Postgres + Redis** em rede interna; DB/Redis **não expostos** à internet |

> ⚠️ O `docker-compose.yml` é só de **dev** (Postgres/Redis nas portas 5433/6380).
> Na VPS use sempre o `docker-compose.prod.yml`.

---

## 1. Ajustar o `.env` de produção

Dentro do Docker, o host do banco/redis passa a ser o **nome do serviço**
(`postgres`/`redis`) nas portas **padrão** (5432/6379), não mais `localhost:5433`.
Crie o `.env` na VPS a partir deste template:

```env
NODE_ENV=production
PORT=3333
# Host CANÔNICO do front (apex, sem www). É a origin exata liberada no CORS e o
# alvo do redirect pós-OAuth. Precisa bater com o Origin que o browser envia.
FRONTEND_URL=https://deepalpha.fun
# Origens EXTRAS confiáveis (CSV). O front redireciona www→apex, mas listamos o
# www como rede de segurança para qualquer request que escape antes do redirect.
CORS_ADDITIONAL_ORIGINS=https://www.deepalpha.fun
API_PUBLIC_URL=https://api.deepalpha.fun

# --- Postgres: host = nome do serviço "postgres", porta 5432 ---
POSTGRES_USER=deepalpha
POSTGRES_PASSWORD=<SENHA_FORTE_DB>
POSTGRES_DB=deepalpha
DATABASE_URL="postgresql://deepalpha:<SENHA_FORTE_DB>@postgres:5432/deepalpha?schema=public"

# --- Redis: host = nome do serviço "redis", porta 6379 ---
REDIS_ENABLED=true
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=<SENHA_FORTE_REDIS>

# --- Segredos (gere com: openssl rand -base64 48) ---
JWT_SECRET=<...>
SESSION_SECRET=<...>
COOKIE_DOMAIN=.deepalpha.fun

# --- Obrigatórios em prod ---
CLOUDFLARE_TURNSTILE_SECRET_KEY=<...>
MORALIS_API_KEY=<...>
GOOGLE_CLIENT_ID=<...>
GOOGLE_CLIENT_SECRET=<...>
GOOGLE_CALLBACK_URL=https://api.deepalpha.fun/api/v1/auth/google/callback
SEND_GRID=<...>
SOLANA_RPC_URL=<Helius/QuickNode em prod>
```

`POSTGRES_PASSWORD` e `REDIS_PASSWORD` são lidos **tanto** pela app **quanto**
pelo compose (para subir os containers de DB/Redis). Por isso ficam no mesmo `.env`.

---

## 2. Preparar a VPS (uma vez só)

```bash
# como root/sudo, numa VPS Ubuntu/Debian
curl -fsSL https://get.docker.com | sh          # Docker Engine + compose plugin
sudo usermod -aG docker $USER                   # rodar docker sem sudo (relogar depois)

# Firewall: só 22/80/443 abertos. DB/Redis NÃO ficam expostos (rede interna).
sudo ufw allow 22 && sudo ufw allow 80 && sudo ufw allow 443
sudo ufw enable
```

---

## 3. Subir o código na VPS

**A) Git (recomendado):**
```bash
git clone <seu-repo> /opt/deepalpha
cd /opt/deepalpha/backend
nano .env          # cola o .env do passo 1
```

**B) Sem git:** copie a pasta do Windows com `scp`/`rsync`. **Não** copie
`node_modules`, `dist` nem o `.env` local — o build gera tudo dentro do container.

---

## 4. Build e deploy

```bash
cd /opt/deepalpha/backend
docker compose -f docker-compose.prod.yml up -d --build
```

Fluxo: builda a imagem → sobe Postgres/Redis → espera ficarem *healthy* →
o entrypoint roda as migrations → a app sobe em `127.0.0.1:3333`.

Verificar:
```bash
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f app
curl http://127.0.0.1:3333/health
```

---

## 5. HTTPS na frente (essencial)

A app está ligada em `127.0.0.1:3333` de propósito — não deve ser acessada direto
por IP:porta em produção (sem TLS, cookies de auth vazam). Use um reverse proxy com
TLS automático. O mais simples é **Caddy**:

`/etc/caddy/Caddyfile`:
```
api.deepalpha.app {
    reverse_proxy 127.0.0.1:3333
}
```

Caddy resolve o certificado Let's Encrypt sozinho. (Nginx + certbot também funciona.)

> Aponte o DNS `api.deepalpha.app` → IP da VPS antes disso.

---

## 6. Atualizações futuras (redeploy)

```bash
cd /opt/deepalpha/backend
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

As migrations rodam automaticamente no start. Zero passos manuais.

---

## Considerações (Performance / Segurança / Escalabilidade)

- **Performance:** imagem Alpine + multi-stage → runtime enxuto; o
  `binaryTarget linux-musl-openssl-3.0.x` já está no `schema.prisma`, então o
  Prisma roda nativo sem fallback. Ajuste `DATABASE_CONNECTION_LIMIT` no `.env`
  conforme os cores da VPS.
- **Segurança:** container roda como `node` (não-root); DB/Redis sem portas
  expostas; Redis com senha (defesa em profundidade); `.env` fora da imagem
  (não é "baked"); TLS obrigatório no proxy.
- **Escalabilidade:** para escalar horizontalmente depois, tire Postgres/Redis do
  compose e use serviços gerenciados (RDS/Elasticache ou equivalentes) — a app já
  é stateless (sessão no Redis), então basta subir N réplicas atrás do proxy.

---

## Ponto de atenção: pasta `uploads/`

A pasta `uploads/` (avatares re-hospedados) é **efêmera** no container — some a cada
redeploy. Opções:

1. Volume persistente no serviço `app` do `docker-compose.prod.yml`:
   ```yaml
       volumes:
         - deepalpha_uploads:/app/uploads
   ```
   (e declarar `deepalpha_uploads:` no bloco `volumes:`)
2. **Ideal:** servir uploads pelo GCS (`@google-cloud/storage` já está nas deps),
   sem depender do disco da VPS.

---

## Troubleshooting rápido

| Sintoma | Causa provável / ação |
|---|---|
| `app` reinicia em loop | Ver `logs -f app`. Migração falhou ou `DATABASE_URL` aponta p/ `localhost` em vez de `postgres`. |
| `P1001: Can't reach database` | `DATABASE_URL` deve usar host `postgres:5432` (nome do serviço), não `localhost:5433`. |
| Redis `NOAUTH`/timeout | `REDIS_HOST=redis`, `REDIS_PORT=6379`, `REDIS_PASSWORD` igual ao do compose. |
| Healthcheck nunca fica *healthy* | Confirme `GET /health` responde 200 e a porta interna é 3333. |
| Cookies de login não colam | `COOKIE_DOMAIN` e URLs `https://` corretas; precisa do proxy TLS (passo 5). |
