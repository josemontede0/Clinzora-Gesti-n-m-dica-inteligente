import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';

export const PASSWORD = 'Prueba#Segura2026';

export async function bootApp() {
  const app = await createApp();
  await app.init();
  return { app, prisma: app.get(PrismaService) };
}

export interface Client {
  get(url: string): request.Test;
  post(url: string, body?: object): request.Test;
  put(url: string, body?: object): request.Test;
  cookie: string;
}

/** Cliente autenticado: guarda la cookie de sesión y envía la cabecera anti-CSRF. */
export async function login(app: INestApplication, email: string, password = PASSWORD): Promise<Client> {
  const res = await request(app.getHttpServer()).post('/auth/login').set('x-requested-with', 'medigest').send({ email, password });
  if (res.status !== 200) throw new Error(`Login ${email} falló: ${res.status} ${JSON.stringify(res.body)}`);
  const cookie = (res.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  const server = app.getHttpServer();
  return {
    cookie,
    get: (url) => request(server).get(url).set('cookie', cookie),
    post: (url, body) => request(server).post(url).set('cookie', cookie).set('x-requested-with', 'medigest').send(body ?? {}),
    put: (url, body) => request(server).put(url).set('cookie', cookie).set('x-requested-with', 'medigest').send(body ?? {}),
  };
}

export const key = () => randomUUID();

/** Cédula ficticia válida de la serie 000 a partir de un número. */
export function fakeCedula(serial: number): string {
  const base = `000${String(serial).padStart(7, '0')}`;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    let n = Number(base[i]) * (i % 2 === 0 ? 1 : 2);
    if (n > 9) n -= 9;
    sum += n;
  }
  return base + String((10 - (sum % 10)) % 10);
}

/** Próximo día hábil (lunes a viernes) a partir de mañana, como YYYY-MM-DD en Santo Domingo. */
export function nextBusinessDay(offset = 1): string {
  const d = new Date(Date.now() - 4 * 3600_000);
  d.setUTCDate(d.getUTCDate() + offset);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** ISO de una hora local de Santo Domingo (UTC−4, sin horario de verano). */
export const at = (ymd: string, hh: number, mm = 0) => `${ymd}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00-04:00`;
