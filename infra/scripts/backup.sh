#!/usr/bin/env bash
# Respaldo cifrado de MediGest: base de datos (pg_dump formato custom) + archivos privados.
# Requiere: pg_dump, tar, openssl. Variables:
#   DATABASE_URL        cadena de conexión (postgresql://usuario:clave@host:puerto/base)
#   BACKUP_PASSPHRASE   frase de cifrado (guárdela fuera del servidor; sin ella no se puede restaurar)
#   STORAGE_DIR         carpeta de archivos privados (por defecto infra/storage)
#   BACKUP_DIR          destino (por defecto infra/backups)
set -euo pipefail
: "${DATABASE_URL:?Defina DATABASE_URL}"
: "${BACKUP_PASSPHRASE:?Defina BACKUP_PASSPHRASE}"
STORAGE_DIR="${STORAGE_DIR:-infra/storage}"
BACKUP_DIR="${BACKUP_DIR:-infra/backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

DB_URL="${DATABASE_URL%%\?*}"   # pg_dump no acepta ?schema=
pg_dump --format=custom --no-owner --file "$TMP/db.dump" "$DB_URL"
mkdir -p "$STORAGE_DIR"
tar -czf "$TMP/storage.tgz" -C "$STORAGE_DIR" .
tar -cf "$TMP/medigest.tar" -C "$TMP" db.dump storage.tgz
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -in "$TMP/medigest.tar" -out "$BACKUP_DIR/medigest-$STAMP.tar.enc" -pass env:BACKUP_PASSPHRASE
sha256sum "$BACKUP_DIR/medigest-$STAMP.tar.enc" > "$BACKUP_DIR/medigest-$STAMP.tar.enc.sha256"
echo "Respaldo creado: $BACKUP_DIR/medigest-$STAMP.tar.enc"
