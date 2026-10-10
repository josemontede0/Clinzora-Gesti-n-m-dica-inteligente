#!/usr/bin/env bash
# Restaura un respaldo cifrado en la base indicada (DEBE estar vacía o ser una base nueva).
# Uso: DATABASE_URL=... BACKUP_PASSPHRASE=... STORAGE_DIR=... infra/scripts/restore.sh archivo.tar.enc
# Nunca restaure sobre producción sin un procedimiento aprobado: pruebe primero en una base aparte.
set -euo pipefail
FILE="${1:?Indique el archivo .tar.enc}"
: "${DATABASE_URL:?Defina DATABASE_URL}"
: "${BACKUP_PASSPHRASE:?Defina BACKUP_PASSPHRASE}"
STORAGE_DIR="${STORAGE_DIR:-infra/storage-restaurado}"
if [ -f "$FILE.sha256" ]; then sha256sum -c "$FILE.sha256"; fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "$FILE" -out "$TMP/medigest.tar" -pass env:BACKUP_PASSPHRASE
tar -xf "$TMP/medigest.tar" -C "$TMP"
DB_URL="${DATABASE_URL%%\?*}"
pg_restore --no-owner --exit-on-error --dbname "$DB_URL" "$TMP/db.dump"
mkdir -p "$STORAGE_DIR"
tar -xzf "$TMP/storage.tgz" -C "$STORAGE_DIR"
echo "Restauración completa en la base indicada y archivos en $STORAGE_DIR"
