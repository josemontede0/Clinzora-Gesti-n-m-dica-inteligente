import { BadRequestException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type AuthenticatorTransportFuture, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { config } from '../../config';
import { AuthUser } from '../../common/context';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/audit.service';
import { SessionService } from './session.service';

/**
 * Llaves de acceso (WebAuthn): Face ID / Touch ID en iPhone, huella o rostro en Android, Windows Hello.
 * Siempre con verificación del usuario (biometría o PIN del equipo), por eso una sesión iniciada así
 * cumple la verificación en dos pasos. El dominio de la llave es el de esta instalación (WEB_ORIGIN).
 */
@Injectable()
export class PasskeyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  private rp() {
    const origin = config.WEB_ORIGIN.replace(/\/$/, '');
    return { origin, rpID: new URL(origin).hostname };
  }

  private async saveChallenge(kind: 'login' | 'register', challenge: string, userId?: string) {
    await this.prisma.webAuthnChallenge.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    const c = await this.prisma.webAuthnChallenge.create({ data: { kind, challenge, userId, expiresAt: new Date(Date.now() + 5 * 60_000) } });
    return c.id;
  }

  /** Consume el desafío (un solo uso). */
  private async takeChallenge(id: string, kind: 'login' | 'register', userId?: string) {
    const rows = await this.prisma.webAuthnChallenge.deleteMany({ where: { id, kind, expiresAt: { gt: new Date() }, ...(userId ? { userId } : {}) } });
    if (!rows.count) return null;
    return true;
  }

  async loginOptions() {
    const options = await generateAuthenticationOptions({ rpID: this.rp().rpID, userVerification: 'required', allowCredentials: [] });
    const challengeId = await this.saveChallenge('login', options.challenge);
    return { challengeId, options };
  }

  async login(challengeId: string, response: AuthenticationResponseJSON, ip?: string, userAgent?: string) {
    const challenge = await this.prisma.webAuthnChallenge.findUnique({ where: { id: challengeId } });
    if (!challenge || !(await this.takeChallenge(challengeId, 'login'))) throw new BadRequestException('La solicitud venció. Intente de nuevo.');
    const pk = await this.prisma.userPasskey.findUnique({ where: { credentialId: response.id }, include: { user: true } });
    if (!pk) throw new UnauthorizedException('Esta llave de acceso no está registrada. Entre con su contraseña y actívela en Mi perfil.');
    const u = pk.user;
    const base = { organizationId: u.organizationId, userId: u.id, userEmail: u.email, entity: 'User', entityId: u.id };
    if (!u.active || u.deletedAt) throw new UnauthorizedException('La cuenta no está activa.');
    if (u.lockedUntil && u.lockedUntil > new Date()) throw new ForbiddenException('Cuenta bloqueada temporalmente.');
    const { origin, rpID } = this.rp();
    let newCounter: number;
    try {
      const v = await verifyAuthenticationResponse({
        response, expectedChallenge: challenge.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
        credential: { id: pk.credentialId, publicKey: new Uint8Array(pk.publicKey), counter: Number(pk.counter), transports: pk.transports as AuthenticatorTransportFuture[] },
      });
      if (!v.verified) throw new Error('no verificada');
      newCounter = v.authenticationInfo.newCounter;
    } catch {
      await this.audit.log({ ...base, action: 'LOGIN_PASSKEY_FALLIDO', details: { dispositivo: pk.deviceName } });
      throw new UnauthorizedException('No se pudo verificar la llave de acceso.');
    }
    await this.prisma.userPasskey.update({ where: { id: pk.id }, data: { counter: BigInt(newCounter), lastUsedAt: new Date() } });
    await this.prisma.user.update({ where: { id: u.id }, data: { failedLoginCount: 0, lastLoginAt: new Date() } });
    const { token } = await this.sessions.create(u.id, true, ip, userAgent, true);
    await this.audit.log({ ...base, action: 'LOGIN', details: { metodo: 'llave de acceso', dispositivo: pk.deviceName } });
    return token;
  }

  async list(user: AuthUser) {
    const rows = await this.prisma.userPasskey.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } });
    return rows.map((p) => ({ id: p.id, deviceName: p.deviceName, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt }));
  }

  async registerOptions(user: AuthUser) {
    const [org, existing] = await Promise.all([
      this.prisma.organization.findUniqueOrThrow({ where: { id: user.organizationId }, select: { name: true } }),
      this.prisma.userPasskey.findMany({ where: { userId: user.id }, select: { credentialId: true, transports: true } }),
    ]);
    const options = await generateRegistrationOptions({
      rpName: org.name, rpID: this.rp().rpID, userName: user.email, userDisplayName: user.fullName,
      userID: new TextEncoder().encode(user.id), attestationType: 'none',
      excludeCredentials: existing.map((c) => ({ id: c.credentialId, transports: c.transports as AuthenticatorTransportFuture[] })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    const challengeId = await this.saveChallenge('register', options.challenge, user.id);
    return { challengeId, options };
  }

  async register(user: AuthUser, challengeId: string, response: RegistrationResponseJSON, deviceName: string) {
    const challenge = await this.prisma.webAuthnChallenge.findUnique({ where: { id: challengeId } });
    if (!challenge || !(await this.takeChallenge(challengeId, 'register', user.id))) throw new BadRequestException('La solicitud venció. Intente de nuevo.');
    const { origin, rpID } = this.rp();
    let v;
    try {
      v = await verifyRegistrationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
    } catch (e) {
      throw new BadRequestException(`No se pudo registrar la llave de acceso: ${(e as Error).message}`);
    }
    if (!v.verified || !v.registrationInfo) throw new BadRequestException('No se pudo registrar la llave de acceso.');
    const { credential } = v.registrationInfo;
    if (await this.prisma.userPasskey.findUnique({ where: { credentialId: credential.id } })) throw new BadRequestException('Esta llave de acceso ya está registrada.');
    const pk = await this.prisma.userPasskey.create({
      data: {
        userId: user.id, credentialId: credential.id, publicKey: Buffer.from(credential.publicKey), counter: BigInt(credential.counter),
        transports: credential.transports ?? [], deviceName,
      },
    });
    await this.audit.log({ action: 'PASSKEY_REGISTRADA', entity: 'User', entityId: user.id, details: { dispositivo: deviceName } });
    return { id: pk.id, deviceName: pk.deviceName, createdAt: pk.createdAt, lastUsedAt: null };
  }

  async remove(user: AuthUser, id: string) {
    const r = await this.prisma.userPasskey.deleteMany({ where: { id, userId: user.id } });
    if (!r.count) throw new NotFoundException('Llave de acceso no encontrada');
    await this.audit.log({ action: 'PASSKEY_ELIMINADA', entity: 'User', entityId: user.id, details: { id } });
  }
}
