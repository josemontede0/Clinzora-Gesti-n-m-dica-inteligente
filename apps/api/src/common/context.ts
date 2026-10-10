import { AsyncLocalStorage } from 'node:async_hooks';
import type { PermissionCode } from '@medigest/shared';

export interface AuthUser {
  id: string;
  organizationId: string;
  email: string;
  fullName: string;
  sessionId: string;
  permissions: Set<string>;
  roleCodes: string[];
  /** Sucursales asignadas. Si allBranches es true, la cuenta opera en todas las de su organización. */
  branchIds: string[];
  allBranches: boolean;
  professionalId: string | null;
  mfaEnabled: boolean;
  mfaRequired: boolean;
  mustChangePassword: boolean;
}

export interface RequestContext {
  requestId: string;
  ip?: string;
  userAgent?: string;
  user?: AuthUser;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function currentContext(): RequestContext | undefined {
  return requestContext.getStore();
}

export function hasPermission(user: AuthUser, code: PermissionCode): boolean {
  return user.permissions.has(code);
}
