#!/usr/bin/env bash
# Despliegue / actualización de Clinzora en un VPS Ubuntu con Node 20+, PostgreSQL, Nginx, PM2 y certbot.
# Idempotente: la primera vez instala; las siguientes actualizan desde GitHub, migran y reinician.
# Los secretos se generan en el servidor (/etc/clinzora, permisos 600) y nunca se versionan.
#
# Uso (como root en el servidor):
#   DOMAIN=clinzora.konviard.cloud bash vps-setup.sh            # instala o actualiza
#   DOMAIN=clinzora.konviard.cloud SEED_DEMO=1 bash vps-setup.sh  # además carga datos de demostración (solo si la base está vacía)
set -euo pipefail

DOMAIN="${DOMAIN:?Defina DOMAIN, p. ej. clinzora.konviard.cloud}"
APP=/opt/clinzora
CONF=/etc/clinzora
STORAGE=/var/lib/clinzora/storage
BACKUPS=/var/backups/clinzora
WEB_PORT="${WEB_PORT:-3100}"
API_PORT="${API_PORT:-3101}"
REPO="${REPO:-https://github.com/josemontede0/Clinzora-Gesti-n-m-dica-inteligente.git}"
BRANCH="${BRANCH:-main}"

log() { printf '\n==> %s\n' "$*"; }
rand() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c "${1:-40}"; }

log "Comprobando puertos $WEB_PORT/$API_PORT"
for p in "$WEB_PORT" "$API_PORT"; do
  if ss -ltn "sport = :$p" | grep -q LISTEN && ! pm2 jlist 2>/dev/null | grep -q '"name":"clinzora-'; then
    echo "El puerto $p ya está en uso por otro servicio. Elija otro con WEB_PORT/API_PORT." >&2; exit 1
  fi
done

log "Node 22 propio de Clinzora (no se toca el Node del sistema que usan otras aplicaciones)"
NODE_DIR=/opt/clinzora-node
if [ ! -x "$NODE_DIR/bin/node" ]; then
  NODE_VER="$(curl -fsSL https://nodejs.org/dist/index.json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).find(r=>r.version.startsWith("v22.")).version))')"
  TMP="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-x64.tar.xz" -o "$TMP/node.tar.xz"
  curl -fsSL "https://nodejs.org/dist/$NODE_VER/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  (cd "$TMP" && grep " node-$NODE_VER-linux-x64.tar.xz\$" SHASUMS256.txt | sed "s#node-$NODE_VER-linux-x64.tar.xz#node.tar.xz#" | sha256sum -c -)
  mkdir -p "$NODE_DIR" && tar -xJf "$TMP/node.tar.xz" -C "$NODE_DIR" --strip-components=1 && rm -rf "$TMP"
fi
export PATH="$NODE_DIR/bin:$PATH"
NODE_BIN="$NODE_DIR/bin/node"
echo "node $("$NODE_BIN" -v)"
command -v pnpm >/dev/null && [ "$(dirname "$(command -v pnpm)")" = "$NODE_DIR/bin" ] || npm i -g --silent pnpm@11.3.0
command -v pm2 >/dev/null || { echo "Se requiere PM2 instalado en el sistema" >&2; exit 1; }
mkdir -p "$CONF" "$STORAGE" "$BACKUPS"
chmod 700 "$CONF" "$BACKUPS"

log "Código ($BRANCH)"
if [ -d "$APP/.git" ]; then
  git -C "$APP" fetch --quiet origin "$BRANCH"
  git -C "$APP" reset --quiet --hard "origin/$BRANCH"   # el servidor no guarda cambios locales: todo vive en GitHub
else
  git clone --quiet --branch "$BRANCH" "$REPO" "$APP"
fi

log "Base de datos"
[ -f "$CONF/db.pass" ] || { rand 32 > "$CONF/db.pass"; chmod 600 "$CONF/db.pass"; }
DBP="$(cat "$CONF/db.pass")"
if ! sudo -u postgres psql -tAc "select 1 from pg_roles where rolname='clinzora'" | grep -q 1; then
  sudo -u postgres psql -q -c "create role clinzora login password '$DBP'"
fi
if ! sudo -u postgres psql -tAc "select 1 from pg_database where datname='clinzora'" | grep -q 1; then
  sudo -u postgres createdb -O clinzora -E UTF8 clinzora
fi
sudo -u postgres psql -q -d clinzora -c "create extension if not exists btree_gist; create extension if not exists unaccent;"

log "Configuración"
if [ ! -f "$CONF/api.env" ]; then
  cat > "$CONF/api.env" <<EOF
NODE_ENV=production
PORT=$API_PORT
API_HOST=127.0.0.1
WEB_ORIGIN=https://$DOMAIN
PUBLIC_API_URL=https://$DOMAIN/backend
DATABASE_URL=postgresql://clinzora:$DBP@127.0.0.1:5432/clinzora?schema=public
SESSION_SECRET=$(rand 48)
MFA_ENCRYPTION_KEY=$(openssl rand -hex 32)
FILE_URL_SECRET=$(rand 48)
SESSION_IDLE_MINUTES=60
SESSION_ABSOLUTE_HOURS=12
STORAGE_DIR=$STORAGE
NOTIFICATIONS_MODE=test
MAIL_OUTBOX_DIR=/var/lib/clinzora/mail-outbox
PAYMENTS_PROVIDER=none
FISCAL_PROVIDER=manual
EOF
  chmod 600 "$CONF/api.env"
fi
[ -f "$CONF/backup.pass" ] || { rand 40 > "$CONF/backup.pass"; chmod 600 "$CONF/backup.pass"; }
ln -sf "$CONF/api.env" "$APP/apps/api/.env"
printf 'API_URL=http://127.0.0.1:%s\nAPP_URL=https://%s\n' "$API_PORT" "$DOMAIN" > "$APP/apps/web/.env"

log "Dependencias y compilación"
cd "$APP"
CI=1 pnpm install --frozen-lockfile --reporter=silent
pnpm --filter @medigest/shared build
pnpm --filter @medigest/api build
(cd apps/api && npx prisma migrate deploy)
if [ "${SEED_DEMO:-0}" = "1" ]; then
  ORGS="$(sudo -u postgres psql -d clinzora -tAc 'select count(*) from "Organization"')"
  if [ "$ORGS" = "0" ]; then
    log "Cargando datos de demostración (ficticios)"
    (cd apps/api && SEED_ALLOW_PRODUCTION=1 node dist/prisma/seed.js)
    chmod 600 "$APP/infra/seed-credentials.txt"
  else
    echo "La base ya tiene datos: no se carga la demostración."
  fi
fi
API_URL="http://127.0.0.1:$API_PORT" APP_URL="https://$DOMAIN" NEXT_TELEMETRY_DISABLED=1 pnpm --filter @medigest/web build

log "Procesos (PM2)"
if pm2 describe clinzora-api >/dev/null 2>&1; then
  APP_URL="https://$DOMAIN" pm2 restart clinzora-api clinzora-web --update-env
else
  NODE_ENV=production pm2 start dist/src/main.js --name clinzora-api --cwd "$APP/apps/api" --interpreter "$NODE_BIN" --node-args="--enable-source-maps" --max-memory-restart 600M
  NODE_ENV=production APP_URL="https://$DOMAIN" pm2 start node_modules/next/dist/bin/next --name clinzora-web --cwd "$APP/apps/web" --interpreter "$NODE_BIN" --max-memory-restart 600M -- start -p "$WEB_PORT" -H 127.0.0.1
fi
pm2 save --force >/dev/null

log "Nginx"
SITE=/etc/nginx/sites-available/clinzora
if [ ! -f "$SITE" ]; then
  cat > "$SITE" <<EOF
# Clinzora — $DOMAIN (certbot agrega el bloque HTTPS)
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    client_max_body_size 20M;

    location / {
        proxy_pass http://127.0.0.1:$WEB_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }
}
EOF
  ln -sf "$SITE" /etc/nginx/sites-enabled/clinzora
fi
nginx -t   # si la configuración tiene errores, se detiene aquí sin recargar
systemctl reload nginx

log "Respaldo diario"
cat > /etc/cron.d/clinzora-backup <<EOF
# Respaldo cifrado diario de Clinzora (02:30), conserva 30 días.
30 2 * * * root cd $APP && DATABASE_URL="\$(grep ^DATABASE_URL= $CONF/api.env | cut -d= -f2-)" BACKUP_PASSPHRASE="\$(cat $CONF/backup.pass)" STORAGE_DIR=$STORAGE BACKUP_DIR=$BACKUPS bash infra/scripts/backup.sh >> /var/log/clinzora-backup.log 2>&1 && find $BACKUPS -name 'medigest-*' -mtime +30 -delete
EOF

log "Verificación"
for i in $(seq 1 30); do curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null && break; sleep 2; done
curl -sf "http://127.0.0.1:$API_PORT/health" && echo
curl -s -o /dev/null -w "web local: %{http_code}\n" -H "Host: $DOMAIN" http://127.0.0.1/login
# La redirección al login debe usar el dominio público, nunca el host interno.
LOC="$(curl -s -o /dev/null -w '%{redirect_url}' -H "Host: $DOMAIN" "http://127.0.0.1:$WEB_PORT/pacientes")"
case "$LOC" in "https://$DOMAIN/"*) echo "redirección al login: $LOC" ;; *) echo "ERROR: la redirección al login no usa el dominio público ($LOC)" >&2; exit 1 ;; esac
echo "Listo. Si el DNS ya apunta aquí, active HTTPS con:"
echo "  certbot --nginx -d $DOMAIN --non-interactive --agree-tos --redirect --no-eff-email"
