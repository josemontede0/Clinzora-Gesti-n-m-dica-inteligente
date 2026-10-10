import { ForbiddenException, Injectable } from '@nestjs/common';
import { fromCents, toCents } from '@medigest/shared';
import { AuditService } from '../../common/audit.service';
import { AuthUser } from '../../common/context';
import { BusinessError } from '../../common/errors';
import { assertBranch, found } from '../../common/scope';
import { PrismaService } from '../../prisma/prisma.service';
import { c, dec } from './money-db';

@Injectable()
export class CashService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async current(user: AuthUser) {
    const session = await this.prisma.cashSession.findFirst({
      where: { organizationId: user.organizationId, openedById: user.id, status: 'ABIERTA' },
      include: { register: { include: { branch: { select: { id: true, name: true } } } } },
    });
    return { session: session ? { ...session, summary: await this.summary(session.id) } : null };
  }

  async open(user: AuthUser, registerId: string, openingFloat: string) {
    const register = found(await this.prisma.cashRegister.findFirst({ where: { id: registerId, organizationId: user.organizationId, active: true } }), 'Caja');
    assertBranch(user, register.branchId);
    const mine = await this.prisma.cashSession.findFirst({ where: { organizationId: user.organizationId, openedById: user.id, status: 'ABIERTA' } });
    if (mine) throw new BusinessError('Ya tiene una caja abierta. Ciérrela antes de abrir otra.');
    // El índice único parcial impide dos sesiones abiertas en la misma caja aunque se intente a la vez (→ 409).
    const session = await this.prisma.$transaction(async (tx) => {
      const s = await tx.cashSession.create({
        data: { organizationId: user.organizationId, registerId, branchId: register.branchId, openedById: user.id, openingFloat: dec(toCents(openingFloat)) },
      });
      await tx.cashMovement.create({ data: { sessionId: s.id, type: 'FONDO_INICIAL', methodKind: 'EFECTIVO', amount: dec(toCents(openingFloat)), description: 'Fondo inicial', createdById: user.id } });
      await this.audit.log({ action: 'CAJA_ABIERTA', entity: 'CashSession', entityId: s.id, branchId: register.branchId, details: { caja: register.name, fondo: openingFloat } }, tx);
      return s;
    });
    return this.get(user, session.id);
  }

  /** Totales por método y por tipo de movimiento. El efectivo esperado incluye el fondo inicial. */
  async summary(sessionId: string) {
    const movements = await this.prisma.cashMovement.groupBy({ by: ['methodKind', 'type'], where: { sessionId }, _sum: { amount: true }, _count: true });
    const byMethod: Record<string, number> = {};
    const byType: Record<string, number> = {};
    for (const m of movements) {
      byMethod[m.methodKind] = (byMethod[m.methodKind] ?? 0) + c(m._sum.amount);
      byType[m.type] = (byType[m.type] ?? 0) + c(m._sum.amount);
    }
    return {
      expectedCash: fromCents(byMethod.EFECTIVO ?? 0),
      byMethod: Object.fromEntries(Object.entries(byMethod).map(([k, v]) => [k, fromCents(v)])),
      byType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, fromCents(v)])),
    };
  }

  async get(user: AuthUser, id: string) {
    const s = found(
      await this.prisma.cashSession.findFirst({
        where: { id, organizationId: user.organizationId },
        include: { register: { include: { branch: { select: { id: true, name: true } } } }, movements: { orderBy: { createdAt: 'asc' } } },
      }),
      'Sesión de caja',
    );
    if (s.openedById !== user.id && !user.permissions.has('cash.supervise')) throw new ForbiddenException('Solo puede ver su propia caja');
    const users = await this.prisma.user.findMany({ where: { id: { in: [s.openedById, s.closedById].filter((x): x is string => !!x) } }, select: { id: true, fullName: true } });
    return { ...s, users, summary: await this.summary(id) };
  }

  async list(user: AuthUser, q: { branchId?: string; status?: string }) {
    const supervise = user.permissions.has('cash.supervise');
    if (q.branchId) assertBranch(user, q.branchId);
    const sessions = await this.prisma.cashSession.findMany({
      where: {
        organizationId: user.organizationId,
        ...(supervise ? {} : { openedById: user.id }),
        ...(q.branchId ? { branchId: q.branchId } : user.allBranches ? {} : { branchId: { in: user.branchIds } }),
        ...(q.status ? { status: q.status as never } : {}),
      },
      include: { register: { select: { name: true, branch: { select: { name: true } } } } },
      orderBy: { openedAt: 'desc' },
      take: 200,
    });
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(sessions.flatMap((s) => [s.openedById, s.closedById]).filter((x): x is string => !!x))] } }, select: { id: true, fullName: true } });
    return sessions.map((s) => ({ ...s, openedBy: users.find((u) => u.id === s.openedById)?.fullName, closedBy: users.find((u) => u.id === s.closedById)?.fullName }));
  }

  /** Cierre con arqueo: compara el efectivo contado con el esperado y guarda la diferencia. */
  async close(user: AuthUser, id: string, countedCash: string, notes: string | null) {
    const s = found(await this.prisma.cashSession.findFirst({ where: { id, organizationId: user.organizationId } }), 'Sesión de caja');
    if (s.openedById !== user.id && !user.permissions.has('cash.supervise')) throw new ForbiddenException('Solo puede cerrar su propia caja');
    if (s.status !== 'ABIERTA') throw new BusinessError('La caja ya está cerrada');
    const summary = await this.summary(id);
    const expected = toCents(summary.expectedCash);
    const counted = toCents(countedCash);
    const difference = counted - expected;
    if (difference !== 0 && !notes) throw new BusinessError('Hay diferencia en el arqueo: explique el motivo en las notas', 'DIFERENCIA_SIN_NOTA');
    await this.prisma.$transaction(async (tx) => {
      const r = await tx.cashSession.updateMany({
        where: { id, status: 'ABIERTA' },
        data: { status: 'CERRADA', closedAt: new Date(), closedById: user.id, expectedCash: dec(expected), countedCash: dec(counted), difference: dec(difference), closingNotes: notes },
      });
      if (!r.count) throw new BusinessError('La caja ya está cerrada');
      await this.audit.log({ action: 'CAJA_CERRADA', entity: 'CashSession', entityId: id, branchId: s.branchId, details: { esperado: fromCents(expected), contado: countedCash, diferencia: fromCents(difference) } }, tx);
    });
    return this.get(user, id);
  }

  async movement(user: AuthUser, id: string, type: 'RETIRO' | 'INGRESO', amount: string, description: string) {
    const s = found(await this.prisma.cashSession.findFirst({ where: { id, organizationId: user.organizationId } }), 'Sesión de caja');
    if (s.openedById !== user.id) throw new ForbiddenException('Solo puede registrar movimientos en su propia caja');
    if (s.status !== 'ABIERTA') throw new BusinessError('La caja está cerrada');
    const cents = toCents(amount);
    if (type === 'RETIRO') {
      const { expectedCash } = await this.summary(id);
      if (cents > toCents(expectedCash)) throw new BusinessError('El retiro supera el efectivo disponible en caja');
    }
    const m = await this.prisma.cashMovement.create({
      data: { sessionId: id, type, methodKind: 'EFECTIVO', amount: dec(type === 'RETIRO' ? -cents : cents), description, createdById: user.id },
    });
    await this.audit.log({ action: type === 'RETIRO' ? 'CAJA_RETIRO' : 'CAJA_INGRESO', entity: 'CashMovement', entityId: m.id, branchId: s.branchId, details: { monto: amount, descripcion: description } });
    return this.get(user, id);
  }
}
