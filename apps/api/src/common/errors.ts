import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { ThrottlerException } from '@nestjs/throttler';
import { currentContext } from './context';
import { logger } from './logger';

/** Error de regla de negocio (422) con mensaje para el usuario. */
export class BusinessError extends HttpException {
  constructor(message: string, code = 'REGLA_DE_NEGOCIO', extra?: Record<string, unknown>) {
    super({ message, code, ...extra }, HttpStatus.UNPROCESSABLE_ENTITY);
  }
}

function pgCode(e: unknown): string | undefined {
  const msg = String((e as Error)?.message ?? '');
  const meta = (e as { meta?: { code?: string } }).meta;
  if (meta?.code) return meta.code;
  const m = msg.match(/\b(23P01|23505|23503|23514|40001)\b/);
  return m?.[1];
}

/**
 * Manejo centralizado de errores. Nunca devuelve trazas ni detalles internos al cliente;
 * las respuestas llevan requestId para correlacionar con los logs.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const requestId = currentContext()?.requestId;
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: Record<string, unknown> = { message: 'Ocurrió un error inesperado. Intente nuevamente.' };

    if (exception instanceof ThrottlerException) {
      status = HttpStatus.TOO_MANY_REQUESTS;
      body = { message: 'Demasiadas solicitudes. Espere un momento e intente de nuevo.' };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r = exception.getResponse();
      body = typeof r === 'string' ? { message: r } : { ...(r as Record<string, unknown>) };
      if (Array.isArray(body.message)) body.message = (body.message as string[]).join('. ');
      delete body.statusCode;
      delete body.error;
      if (status === 404 && /^Cannot (GET|POST|PUT|PATCH|DELETE)/.test(String(body.message))) body.message = 'Recurso no encontrado';
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      const code = pgCode(exception);
      if (exception.code === 'P2002') {
        status = HttpStatus.CONFLICT;
        body = { message: 'Ya existe un registro con esos datos únicos.', code: 'DUPLICADO', fields: exception.meta?.target };
      } else if (exception.code === 'P2025') {
        status = HttpStatus.NOT_FOUND;
        body = { message: 'Registro no encontrado' };
      } else if (exception.code === 'P2003') {
        status = HttpStatus.CONFLICT;
        body = { message: 'El registro está relacionado con otros datos y no puede modificarse así.' };
      } else if (code === '23P01') {
        status = HttpStatus.CONFLICT;
        body = { message: 'El horario ya está ocupado para ese médico o consultorio.', code: 'SOLAPAMIENTO' };
      } else if (code === '23514') {
        status = HttpStatus.UNPROCESSABLE_ENTITY;
        body = { message: 'Los importes o datos no cumplen las reglas de integridad.', code: 'INTEGRIDAD' };
      } else if (exception.code === 'P2034') {
        status = HttpStatus.CONFLICT;
        body = { message: 'Otro usuario modificó estos datos al mismo tiempo. Intente nuevamente.', code: 'CONCURRENCIA' };
      }
    } else if (exception instanceof Prisma.PrismaClientUnknownRequestError) {
      const code = pgCode(exception);
      if (code === '23P01') {
        status = HttpStatus.CONFLICT;
        body = { message: 'El horario ya está ocupado para ese médico o consultorio.', code: 'SOLAPAMIENTO' };
      } else if (code === '23514') {
        status = HttpStatus.UNPROCESSABLE_ENTITY;
        body = { message: 'Los importes o datos no cumplen las reglas de integridad.', code: 'INTEGRIDAD' };
      } else if (code === '40001') {
        status = HttpStatus.CONFLICT;
        body = { message: 'Otro usuario modificó estos datos al mismo tiempo. Intente nuevamente.', code: 'CONCURRENCIA' };
      }
    } else if (exception instanceof Prisma.PrismaClientValidationError) {
      status = HttpStatus.BAD_REQUEST;
      body = { message: 'Solicitud inválida' };
    }

    if (status >= 500) {
      const err = exception as Error;
      logger.error(err?.message ?? 'error', err?.stack, 'ExceptionFilter');
    }
    res.status(status).json({ ...body, statusCode: status, requestId });
  }
}
