/**
 * Recrea la base de PRUEBAS (borra el esquema public y aplica migraciones) y la siembra con la contraseña de pruebas.
 * Salvaguardas: solo actúa sobre TEST_DATABASE_URL, cuyo nombre debe terminar en "_test" y ser distinto de DATABASE_URL.
 * Nunca usar contra desarrollo ni producción.
 */
const { execSync } = require('node:child_process');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const fileEnv = {};
if (existsSync(join(root, '.env'))) {
  for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) fileEnv[m[1]] = m[2];
  }
}
const testDb = process.env.TEST_DATABASE_URL || fileEnv.TEST_DATABASE_URL;
const devDb = fileEnv.DATABASE_URL;
if (!testDb) throw new Error('TEST_DATABASE_URL no está definida');
const dbName = new URL(testDb).pathname.replace(/^\//, '');
if (!dbName.endsWith('_test')) throw new Error(`La base de pruebas debe terminar en "_test" (recibido: ${dbName})`);
if (devDb && new URL(devDb).pathname === new URL(testDb).pathname && new URL(devDb).host === new URL(testDb).host) {
  throw new Error('TEST_DATABASE_URL apunta a la misma base que DATABASE_URL');
}

async function main() {
  const env = { ...process.env, ...fileEnv, DATABASE_URL: testDb, NODE_ENV: 'test', SEED_PASSWORD: process.env.SEED_PASSWORD || 'Prueba#Segura2026' };
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url: testDb } } });
  await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
  await prisma.$executeRawUnsafe('CREATE SCHEMA public');
  await prisma.$disconnect();
  execSync('npx prisma migrate deploy', { cwd: root, env, stdio: 'pipe' });
  if (process.argv.includes('--build')) execSync('npx tsc -p tsconfig.build.json', { cwd: root, env, stdio: 'pipe' });
  execSync('node dist/prisma/seed.js', { cwd: root, env, stdio: 'pipe' });
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
