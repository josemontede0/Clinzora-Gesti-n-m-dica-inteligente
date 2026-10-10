import { execSync } from 'node:child_process';
import { join } from 'node:path';

/** Recrea y siembra la base de pruebas (solo la base *_test; ver apps/api/scripts/reset-test-db.cjs). */
export default async function globalSetup() {
  execSync('node scripts/reset-test-db.cjs --build', { cwd: join(__dirname, '..', '..', 'api'), env: process.env, stdio: 'pipe' });
}
