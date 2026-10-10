import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { config } from '../../config';
import { AuthUser, currentContext } from '../../common/context';
import { ALLOW_PENDING, ANY_PERMISSION_KEY, IS_PUBLIC, PERMISSIONS_KEY } from '../../common/decorators';
import { SESSION_COOKIE, SessionService } from './session.service';

/**
 * Protección CSRF para autenticación por cookie: toda petición que modifica datos debe traer
 * la cabecera X-Requested-With (los formularios de otros sitios no pueden añadirla sin CORS)
 * y, si el navegador envía Origin, debe ser el del frontend. La cookie además es SameSite=Strict.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
    if (req.path.startsWith('/webhooks/')) return true; // Validados por firma/token del proveedor.
    if (req.get('x-requested-with') !== 'medigest') throw new ForbiddenException('Solicitud rechazada (CSRF)');
    const origin = req.get('origin');
    if (origin && origin !== config.WEB_ORIGIN && !origin.startsWith(`http://${config.API_HOST}:`)) {
      throw new ForbiddenException('Origen no permitido');
    }
    return true;
  }
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser; cookies?: Record<string, string> }>();
    const resolved = await this.sessions.resolve(req.cookies?.[SESSION_COOKIE]);
    if (!resolved) throw new UnauthorizedException('Sesión no válida o expirada. Inicie sesión nuevamente.');
    req.user = resolved.user;
    const store = currentContext();
    if (store) store.user = resolved.user;

    const allowPending = this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING, targets);
    if (!allowPending) {
      if (resolved.mfaPending) throw new UnauthorizedException({ message: 'Verificación MFA pendiente', code: 'MFA_PENDIENTE' });
      if (resolved.user.mfaRequired && !resolved.user.mfaEnabled) {
        throw new ForbiddenException({ message: 'Su rol exige activar la verificación en dos pasos', code: 'MFA_REQUERIDO' });
      }
      if (resolved.user.mustChangePassword) {
        throw new ForbiddenException({ message: 'Debe cambiar su contraseña antes de continuar', code: 'CAMBIO_CONTRASENA' });
      }
    }
    return true;
  }
}

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    const all = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, targets) ?? [];
    const any = this.reflector.getAllAndOverride<string[]>(ANY_PERMISSION_KEY, targets) ?? [];
    if (!all.length && !any.length) return true;
    const user = ctx.switchToHttp().getRequest<{ user?: AuthUser }>().user;
    if (!user) throw new UnauthorizedException();
    const okAll = all.every((p) => user.permissions.has(p));
    const okAny = !any.length || any.some((p) => user.permissions.has(p));
    if (!okAll || !okAny) throw new ForbiddenException('No tiene permiso para realizar esta acción');
    return true;
  }
}
