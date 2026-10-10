import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config';

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** AES-256-GCM para secretos en reposo (p. ej. semilla TOTP). Formato: iv.tag.ciphertext en base64url. */
export function encryptSecret(plain: string): string {
  const key = Buffer.from(config.MFA_ENCRYPTION_KEY, 'hex');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}

export function decryptSecret(payload: string): string {
  const [iv, tag, enc] = payload.split('.').map((p) => Buffer.from(p, 'base64url'));
  const key = Buffer.from(config.MFA_ENCRYPTION_KEY, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

/** Firma HMAC para enlaces temporales de descarga de archivos. */
export function signFileUrl(fileId: string, userId: string, expiresAt: number): string {
  return createHmac('sha256', config.FILE_URL_SECRET).update(`${fileId}.${userId}.${expiresAt}`).digest('base64url');
}

export function verifyFileUrl(fileId: string, userId: string, expiresAt: number, signature: string): boolean {
  if (Date.now() > expiresAt) return false;
  const expected = Buffer.from(signFileUrl(fileId, userId, expiresAt));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
