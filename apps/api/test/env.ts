import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Variables para pruebas: base de datos exclusiva (TEST_DATABASE_URL) y carpetas temporales. */
export function applyTestEnv() {
  const envFile = join(__dirname, '..', '.env');
  const vars: Record<string, string> = {};
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) vars[m[1]] = m[2];
    }
  }
  const testDb = process.env.TEST_DATABASE_URL ?? vars.TEST_DATABASE_URL;
  if (!testDb) throw new Error('Defina TEST_DATABASE_URL para ejecutar las pruebas e2e');
  if (vars.DATABASE_URL && testDb === vars.DATABASE_URL) throw new Error('TEST_DATABASE_URL no puede ser la misma base que DATABASE_URL');
  Object.assign(process.env, {
    ...vars,
    NODE_ENV: 'test',
    DATABASE_URL: testDb,
    LOGIN_RATE_LIMIT: '1000',
    SEED_PASSWORD: 'Prueba#Segura2026',
    STORAGE_DIR: '../../infra/test-storage',
    MAIL_OUTBOX_DIR: '../../infra/test-mail-outbox',
    NOTIFICATIONS_MODE: 'test',
    PAYMENTS_PROVIDER: 'test',
    JOBS_ENABLED: 'false',
    MFA_ENFORCE: 'false',
  });
}
