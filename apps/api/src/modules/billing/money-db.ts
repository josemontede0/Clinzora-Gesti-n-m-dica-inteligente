import { Prisma } from '@prisma/client';
import { fromCents, toCents } from '@medigest/shared';

/** Conversión Decimal de Prisma ↔ centavos enteros. */
export const c = (d: Prisma.Decimal | string | number | null | undefined): number => (d == null ? 0 : toCents(d.toString()));
export const dec = (cents: number): Prisma.Decimal => new Prisma.Decimal(fromCents(cents));
