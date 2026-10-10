import { defineConfig, devices } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Pruebas de interfaz contra una instancia AISLADA: API en :3002 y web en :3010, ambas sobre la base de
 * pruebas (TEST_DATABASE_URL), que se recrea y siembra en global-setup. No tocan la base de desarrollo.
 */
const apiEnv = Object.fromEntries(
  readFileSync(join(__dirname, '..', 'api', '.env'), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => [m[1], m[2]]),
);
export const TEST_DB = process.env.TEST_DATABASE_URL ?? apiEnv.TEST_DATABASE_URL;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: 'http://localhost:3010',
    locale: 'es-DO',
    timezoneId: 'America/Santo_Domingo',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'escritorio', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, testIgnore: /movil.spec.ts/ },
    { name: 'movil', use: { ...devices['Pixel 7'] }, testMatch: /movil\.spec\.ts/ },
  ],
  webServer: [
    {
      command: 'node --enable-source-maps dist/src/main.js',
      cwd: join(__dirname, '..', 'api'),
      url: 'http://127.0.0.1:3002/health',
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ...apiEnv,
        NODE_ENV: 'test',
        PORT: '3002',
        DATABASE_URL: TEST_DB,
        WEB_ORIGIN: 'http://localhost:3010',
        LOGIN_RATE_LIMIT: '1000',
        JOBS_ENABLED: 'false',
        STORAGE_DIR: '../../infra/test-storage',
        MAIL_OUTBOX_DIR: '../../infra/test-mail-outbox',
      },
    },
    {
      command: 'npx next dev -p 3010',
      url: 'http://localhost:3010/login',
      reuseExistingServer: false,
      timeout: 180_000,
      env: { API_URL: 'http://127.0.0.1:3002', NEXT_TELEMETRY_DISABLED: '1' },
    },
  ],
});
