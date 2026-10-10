import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { applyTestEnv } from './env';

/** Recrea la base de pruebas desde las migraciones y carga el seed de demostración. */
export default async function globalSetup() {
  applyTestEnv();
  const cwd = join(__dirname, '..');
  const env = { ...process.env };
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
  await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
  await prisma.$executeRawUnsafe('CREATE SCHEMA public');
  await prisma.$disconnect();
  execSync('npx prisma migrate deploy', { cwd, env, stdio: 'pipe' });
  execSync('npx tsc -p tsconfig.build.json', { cwd, env, stdio: 'pipe' });
  execSync('node dist/prisma/seed.js', { cwd, env, stdio: 'pipe' });
}
