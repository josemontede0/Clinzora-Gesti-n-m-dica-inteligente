import { createParamDecorator, ExecutionContext, SetMetadata, UnauthorizedException } from '@nestjs/common';
import type { PermissionCode } from '@medigest/shared';
import type { AuthUser } from './context';

export const IS_PUBLIC = 'isPublic';
/** Endpoint accesible sin sesión. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ALLOW_PENDING = 'allowPending';
/** Permite el acceso con sesión pendiente de MFA o de cambio obligatorio de contraseña. */
export const AllowPending = () => SetMetadata(ALLOW_PENDING, true);

export const PERMISSIONS_KEY = 'permissions';
export const ANY_PERMISSION_KEY = 'anyPermission';
/** Exige todos los permisos indicados. */
export const RequirePermissions = (...codes: PermissionCode[]) => SetMetadata(PERMISSIONS_KEY, codes);
/** Exige al menos uno de los permisos indicados. */
export const RequireAnyPermission = (...codes: PermissionCode[]) => SetMetadata(ANY_PERMISSION_KEY, codes);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<{ user?: AuthUser }>();
  if (!req.user) throw new UnauthorizedException('Sesión requerida');
  return req.user;
});
