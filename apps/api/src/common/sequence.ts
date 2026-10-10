import type { Tx } from '../prisma/prisma.service';

const DEFAULT_PREFIX: Record<string, string> = {
  patient: 'EXP-',
  invoice: 'FAC-',
  payment: 'REC-',
  claim: 'REC-ARS-',
  creditNote: 'NC-',
};

/**
 * Siguiente número de un documento. La fila del contador se bloquea con UPDATE … RETURNING,
 * por lo que dos transacciones concurrentes nunca obtienen el mismo número.
 */
export async function nextNumber(tx: Tx, organizationId: string, key: string): Promise<string> {
  const rows = await tx.$queryRaw<{ prefix: string; value: number; padding: number }[]>`
    UPDATE "DocumentSequence" SET "nextValue" = "nextValue" + 1
    WHERE "organizationId" = ${organizationId}::uuid AND "key" = ${key}
    RETURNING "prefix", "nextValue" - 1 AS value, "padding"`;
  if (rows.length) {
    const r = rows[0];
    return `${r.prefix}${String(r.value).padStart(r.padding, '0')}`;
  }
  await tx.documentSequence.upsert({
    where: { organizationId_key: { organizationId, key } },
    create: { organizationId, key, prefix: DEFAULT_PREFIX[key] ?? `${key.toUpperCase()}-`, nextValue: 1 },
    update: {},
  });
  return nextNumber(tx, organizationId, key);
}
