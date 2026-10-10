import { Global, Injectable, Module } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { currentContext } from './context';
import { redact } from './logger';

export interface AuditEntry {
  action: string;
  entity: string;
  entityId?: string | null;
  branchId?: string | null;
  /** Metadatos o campos modificados. No incluir contenido clínico, contraseñas ni datos de tarjeta. */
  details?: Record<string, unknown>;
  organizationId?: string | null;
  userId?: string | null;
  userEmail?: string | null;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Registra un evento. Si se pasa tx, queda dentro de la misma transacción del cambio auditado. */
  async log(entry: AuditEntry, tx?: Tx) {
    const ctx = currentContext();
    const user = ctx?.user;
    const db = tx ?? this.prisma;
    await db.auditLog.create({
      data: {
        organizationId: entry.organizationId ?? user?.organizationId ?? null,
        userId: entry.userId ?? user?.id ?? null,
        userEmail: entry.userEmail ?? user?.email ?? null,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId ?? null,
        branchId: entry.branchId ?? null,
        ip: ctx?.ip ?? null,
        userAgent: ctx?.userAgent?.slice(0, 250) ?? null,
        details: entry.details ? (redact(entry.details) as Prisma.InputJsonValue) : Prisma.JsonNull,
      },
    });
  }
}

/** Campos que cambiaron entre dos objetos planos (para auditar ediciones sin guardar todo el registro). */
export function changedFields(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return Object.keys(after).filter((k) => {
    const a = before[k] instanceof Date ? (before[k] as Date).toISOString() : before[k];
    const b = after[k] instanceof Date ? (after[k] as Date).toISOString() : after[k];
    return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
  });
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
