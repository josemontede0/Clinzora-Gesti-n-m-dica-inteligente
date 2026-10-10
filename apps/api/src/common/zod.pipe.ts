import { applyDecorators, ArgumentMetadata, BadRequestException, Body, Injectable, PipeTransform, Query } from '@nestjs/common';
import { ApiBody, ApiQuery } from '@nestjs/swagger';
import { z } from 'zod/v4';

@Injectable()
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown, _meta: ArgumentMetadata): z.infer<T> {
    const result = this.schema.safeParse(value ?? {});
    if (!result.success) {
      throw new BadRequestException({
        message: 'Datos inválidos',
        errors: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return result.data;
  }
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  try {
    return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  } catch {
    return { type: 'object' };
  }
}

/** Valida el cuerpo con un esquema Zod compartido y lo documenta en Swagger. */
export const ZBody = (schema: z.ZodType) => Body(new ZodValidationPipe(schema));
export const ApiZBody = (schema: z.ZodType) => applyDecorators(ApiBody({ schema: jsonSchema(schema) as never }));

/** Valida la query string con un esquema Zod. */
export const ZQuery = (schema: z.ZodType) => Query(new ZodValidationPipe(schema));
export const ApiZQuery = (names: string[]) => applyDecorators(...names.map((name) => ApiQuery({ name, required: false })));

/** Paginación y búsqueda comunes. */
export const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export type ListQuery = z.infer<typeof listQuery>;

export function paginate(q: { page: number; pageSize: number }) {
  return { skip: (q.page - 1) * q.pageSize, take: q.pageSize };
}

export function page<T>(items: T[], total: number, q: { page: number; pageSize: number }) {
  return { items, total, page: q.page, pageSize: q.pageSize, pages: Math.max(1, Math.ceil(total / q.pageSize)) };
}
