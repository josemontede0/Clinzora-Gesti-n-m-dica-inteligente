import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { applyTestEnv } from './env';

/** Recrea la base de pruebas desde las migraciones y carga el seed (ver scripts/reset-test-db.cjs). */
export default async function globalSetup() {
  applyTestEnv();
  execSync('node scripts/reset-test-db.cjs --build', { cwd: join(__dirname, '..'), env: process.env, stdio: 'pipe' });
}
