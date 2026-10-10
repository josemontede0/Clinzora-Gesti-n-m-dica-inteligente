import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { AuthUser } from './context';

/**
 * Controles de alcance. Toda consulta filtra por organizationId del usuario autenticado;
 * los identificadores recibidos del cliente nunca bastan por sí solos para acceder a un registro.
 */
export function orgWhere(user: AuthUser) {
  return { organizationId: user.organizationId };
}

/** Filtro de sucursal para listados: todas si la cuenta tiene branches.all, si no solo las asignadas. */
export function branchWhere(user: AuthUser, requested?: string | null): { branchId?: string | { in: string[] } } {
  if (requested) {
    assertBranch(user, requested);
    return { branchId: requested };
  }
  return user.allBranches ? {} : { branchId: { in: user.branchIds } };
}

export function assertBranch(user: AuthUser, branchId: string) {
  if (!user.allBranches && !user.branchIds.includes(branchId)) {
    throw new ForbiddenException('No tiene acceso a esa sucursal');
  }
}

/** Devuelve el registro o 404 si no existe o pertenece a otra organización (no revela su existencia). */
export function found<T>(record: T | null | undefined, what = 'Registro'): T {
  if (!record) throw new NotFoundException(`${what} no encontrado`);
  return record;
}
