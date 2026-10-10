import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { authenticator } from 'otplib';
import { config } from '../../config';
import { AuditService } from '../../common/audit.service';
import { AuthUser } from '../../common/context';
import { decryptSecret, encryptSecret, randomToken, sha256 } from '../../common/crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../notifications/mail.service';
import { SettingsService } from '../settings/settings.service';
import { SessionService } from './session.service';

// Parámetros Argon2id (OWASP: m=19 MiB, t=2, p=1 como mínimo).
const ARGON_OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
const PASSWORD_HISTORY = 5;
// Hash ficticio para igualar el tiempo de respuesta cuando el usuario no existe.
let dummyHash: Promise<string> | null = null;

authenticator.options = { window: 1 };

export async function hashPassword(plain: string) {
  return hash(plain, ARGON_OPTS);
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly mail: MailService,
  ) {}

  async login(email: string, password: string, ip?: string, userAgent?: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    const generic = new UnauthorizedException('Correo o contraseña incorrectos');

    if (!user || user.deletedAt) {
      dummyHash ??= hashPassword('contraseña-ficticia-para-tiempo-constante');
      await verify(await dummyHash, password).catch(() => false);
      await this.audit.log({ action: 'LOGIN_FALLIDO', entity: 'User', details: { reason: 'usuario_inexistente' }, userEmail: email });
      throw generic;
    }
    const policy = await this.settings.operational(user.organizationId);
    const base = { organizationId: user.organizationId, userId: user.id, userEmail: user.email, entity: 'User', entityId: user.id };

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.audit.log({ ...base, action: 'LOGIN_BLOQUEADO' });
      const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
      throw new ForbiddenException(`Cuenta bloqueada temporalmente por intentos fallidos. Intente en ${minutes} minuto(s).`);
    }
    if (!user.active) {
      await this.audit.log({ ...base, action: 'LOGIN_FALLIDO', details: { reason: 'inactivo' } });
      throw generic;
    }

    const ok = await verify(user.passwordHash, password).catch(() => false);
    if (!ok) {
      const failed = user.failedLoginCount + 1;
      const lock = failed >= policy.maxLoginAttempts;
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: lock ? 0 : failed,
          lockedUntil: lock ? new Date(Date.now() + policy.lockoutMinutes * 60000) : undefined,
        },
      });
      await this.audit.log({ ...base, action: lock ? 'CUENTA_BLOQUEADA' : 'LOGIN_FALLIDO', details: { intentos: failed } });
      throw generic;
    }

    await this.prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } });
    const { token } = await this.sessions.create(user.id, !user.mfaEnabled, ip, userAgent);
    await this.audit.log({ ...base, action: 'LOGIN', details: { mfa: user.mfaEnabled } });
    return { token, mfaRequired: user.mfaEnabled };
  }

  async verifyMfa(user: AuthUser, code: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!u.mfaEnabled || !u.mfaSecretEnc) throw new BadRequestException('MFA no está activado para esta cuenta');
    if (!authenticator.check(code, decryptSecret(u.mfaSecretEnc))) {
      await this.audit.log({ action: 'MFA_FALLIDO', entity: 'User', entityId: user.id });
      throw new UnauthorizedException('Código incorrecto');
    }
    await this.sessions.markMfaVerified(user.sessionId);
    await this.audit.log({ action: 'MFA_VERIFICADO', entity: 'User', entityId: user.id });
  }

  /** Paso 1 de la activación: genera un secreto pendiente y devuelve la URI otpauth para el QR. */
  async setupMfa(user: AuthUser) {
    const secret = authenticator.generateSecret();
    await this.prisma.user.update({ where: { id: user.id }, data: { mfaPendingSecretEnc: encryptSecret(secret) } });
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: user.organizationId } });
    return { secret, otpauthUrl: authenticator.keyuri(user.email, org.name, secret) };
  }

  /** Paso 2: confirma con un código válido; solo entonces se activa. */
  async enableMfa(user: AuthUser, code: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!u.mfaPendingSecretEnc) throw new BadRequestException('Inicie primero la configuración de MFA');
    const secret = decryptSecret(u.mfaPendingSecretEnc);
    if (!authenticator.check(code, secret)) throw new BadRequestException('Código incorrecto');
    await this.prisma.user.update({
      where: { id: user.id },
      data: { mfaEnabled: true, mfaSecretEnc: u.mfaPendingSecretEnc, mfaPendingSecretEnc: null },
    });
    await this.sessions.markMfaVerified(user.sessionId);
    await this.audit.log({ action: 'MFA_ACTIVADO', entity: 'User', entityId: user.id });
  }

  async changePassword(user: AuthUser, currentPassword: string, newPassword: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id }, include: { passwordHistory: { orderBy: { createdAt: 'desc' }, take: PASSWORD_HISTORY } } });
    if (!(await verify(u.passwordHash, currentPassword).catch(() => false))) {
      await this.audit.log({ action: 'CAMBIO_CONTRASENA_FALLIDO', entity: 'User', entityId: user.id });
      throw new BadRequestException('La contraseña actual no es correcta');
    }
    await this.assertNotReused(newPassword, [u.passwordHash, ...u.passwordHistory.map((h) => h.passwordHash)]);
    await this.setPassword(u.id, newPassword, u.passwordHash);
    await this.sessions.revokeAllForUser(u.id, user.sessionId);
    await this.audit.log({ action: 'CAMBIO_CONTRASENA', entity: 'User', entityId: user.id });
  }

  /**
   * Solicitud de recuperación. Responde igual exista o no la cuenta (no revela usuarios).
   * El token se guarda como hash y vence en 30 minutos.
   */
  async forgotPassword(email: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.active || user.deletedAt) {
      await this.audit.log({ action: 'RECUPERACION_SOLICITADA', entity: 'User', userEmail: email, details: { existe: false } });
      return;
    }
    const token = randomToken(32);
    await this.prisma.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
    await this.prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 30 * 60000) },
    });
    const link = `${config.WEB_ORIGIN}/restablecer?token=${encodeURIComponent(token)}`;
    await this.mail.send({
      to: user.email,
      subject: 'Restablecer contraseña',
      text: `Hola ${user.fullName}:\n\nPara restablecer su contraseña abra este enlace (válido por 30 minutos):\n${link}\n\nSi no lo solicitó, ignore este mensaje.`,
      sensitive: true,
    });
    await this.audit.log({ organizationId: user.organizationId, userId: user.id, action: 'RECUPERACION_SOLICITADA', entity: 'User', entityId: user.id, details: { existe: true } });
  }

  async resetPassword(token: string, newPassword: string) {
    const row = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: { include: { passwordHistory: { orderBy: { createdAt: 'desc' }, take: PASSWORD_HISTORY } } } },
    });
    if (!row || row.usedAt || row.expiresAt < new Date()) throw new BadRequestException('El enlace no es válido o ya expiró');
    await this.assertNotReused(newPassword, [row.user.passwordHash, ...row.user.passwordHistory.map((h) => h.passwordHash)]);
    await this.prisma.passwordResetToken.update({ where: { id: row.id }, data: { usedAt: new Date() } });
    await this.setPassword(row.userId, newPassword, row.user.passwordHash);
    await this.prisma.user.update({ where: { id: row.userId }, data: { failedLoginCount: 0, lockedUntil: null } });
    await this.sessions.revokeAllForUser(row.userId);
    await this.audit.log({ organizationId: row.user.organizationId, userId: row.userId, action: 'CONTRASENA_RESTABLECIDA', entity: 'User', entityId: row.userId });
  }

  private async assertNotReused(newPassword: string, previous: string[]) {
    for (const h of previous) {
      if (await verify(h, newPassword).catch(() => false)) {
        throw new BadRequestException(`No puede reutilizar ninguna de sus últimas ${PASSWORD_HISTORY} contraseñas`);
      }
    }
  }

  private async setPassword(userId: string, newPassword: string, previousHash: string) {
    const passwordHash = await hashPassword(newPassword);
    await this.prisma.$transaction([
      this.prisma.passwordHistory.create({ data: { userId, passwordHash: previousHash } }),
      this.prisma.user.update({ where: { id: userId }, data: { passwordHash, passwordChangedAt: new Date(), mustChangePassword: false } }),
    ]);
  }

  async logout(user: AuthUser) {
    await this.sessions.revoke(user.sessionId);
    await this.audit.log({ action: 'LOGOUT', entity: 'User', entityId: user.id });
  }

  async me(user: AuthUser, mfaPending: boolean) {
    const [org, branches, settings] = await Promise.all([
      this.prisma.organization.findUniqueOrThrow({ where: { id: user.organizationId } }),
      this.prisma.branch.findMany({
        where: { organizationId: user.organizationId, active: true, ...(user.allBranches ? {} : { id: { in: user.branchIds } }) },
        orderBy: { name: 'asc' },
        select: { id: true, code: true, name: true },
      }),
      this.settings.operational(user.organizationId),
    ]);
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      roles: user.roleCodes,
      permissions: [...user.permissions].sort(),
      professionalId: user.professionalId,
      mfaEnabled: user.mfaEnabled,
      mfaPending,
      mfaSetupRequired: user.mfaRequired && !user.mfaEnabled,
      mustChangePassword: user.mustChangePassword,
      organization: { id: org.id, name: org.name, currency: org.currency, timezone: org.timezone, logoFileId: org.logoFileId },
      productName: settings.productName,
      timeFormat24h: settings.timeFormat24h,
      allowVirtualAppointments: settings.allowVirtualAppointments,
      branches,
    };
  }
}
