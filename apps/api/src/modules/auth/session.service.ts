import { Injectable } from '@nestjs/common';
import { ALL_PERMISSIONS } from '@medigest/shared';
import { config } from '../../config';
import { AuthUser } from '../../common/context';
import { randomToken, sha256 } from '../../common/crypto';
import { PrismaService } from '../../prisma/prisma.service';

export const SESSION_COOKIE = 'mg_session';

export interface ResolvedSession {
  user: AuthUser;
  mfaPending: boolean;
}

@Injectable()
export class SessionService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, mfaVerified: boolean, ip?: string, userAgent?: string, viaPasskey = false) {
    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + config.SESSION_ABSOLUTE_HOURS * 3600_000);
    const session = await this.prisma.session.create({
      data: { userId, tokenHash: sha256(token), mfaVerified, viaPasskey, ip, userAgent: userAgent?.slice(0, 250), expiresAt },
    });
    return { token, session };
  }

  /** Valida el token de la cookie: existencia, revocación, expiración absoluta e inactividad. */
  async resolve(token: string | undefined): Promise<ResolvedSession | null> {
    if (!token || token.length > 200) return null;
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: sha256(token) },
      include: {
        user: {
          include: {
            roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
            branches: true,
            professional: { select: { id: true } },
          },
        },
      },
    });
    if (!session || session.revokedAt) return null;
    const now = Date.now();
    const idleLimit = session.lastSeenAt.getTime() + config.SESSION_IDLE_MINUTES * 60_000;
    if (session.expiresAt.getTime() < now || idleLimit < now) {
      await this.prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
      return null;
    }
    const u = session.user;
    if (!u.active || u.deletedAt || (u.lockedUntil && u.lockedUntil.getTime() > now)) return null;

    // Actualiza la marca de actividad como máximo una vez por minuto.
    if (now - session.lastSeenAt.getTime() > 60_000) {
      await this.prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
    }

    const permissions = new Set<string>();
    for (const ur of u.roles) for (const rp of ur.role.permissions) permissions.add(rp.permission.code);
    // Defensa: solo se reconocen permisos del catálogo.
    for (const p of permissions) if (!(ALL_PERMISSIONS as string[]).includes(p)) permissions.delete(p);
    // Una sesión iniciada con llave de acceso (dispositivo + biometría) ya cumple la verificación en dos pasos.
    const mfaRequired = config.MFA_ENFORCE === true && u.roles.some((r) => r.role.requiresMfa) && !session.viaPasskey;

    const user: AuthUser = {
      id: u.id,
      organizationId: u.organizationId,
      email: u.email,
      fullName: u.fullName,
      sessionId: session.id,
      permissions,
      roleCodes: u.roles.map((r) => r.role.code),
      branchIds: u.branches.map((b) => b.branchId),
      allBranches: permissions.has('branches.all'),
      professionalId: u.professional?.id ?? null,
      mfaEnabled: u.mfaEnabled,
      mfaRequired,
      mustChangePassword: u.mustChangePassword,
    };
    return { user, mfaPending: u.mfaEnabled && !session.mfaVerified };
  }

  async markMfaVerified(sessionId: string) {
    await this.prisma.session.update({ where: { id: sessionId }, data: { mfaVerified: true } });
  }

  async revoke(sessionId: string) {
    await this.prisma.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  async revokeAllForUser(userId: string, exceptSessionId?: string) {
    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
      data: { revokedAt: new Date() },
    });
  }
}
