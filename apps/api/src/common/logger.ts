import { LoggerService } from '@nestjs/common';
import { currentContext } from './context';

/** Claves que nunca deben aparecer en logs. */
const SENSITIVE = /pass(word)?|token|secret|authorization|cookie|cvv|card(number)?|pan|content|note|diagnos|mfa/i;

export function redact(value: unknown, depth = 0): unknown {
  if (value == null || depth > 4) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE.test(k) ? '[REDACTADO]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Logger JSON de una línea por evento, con requestId y usuario (sin datos personales ni clínicos). */
export class JsonLogger implements LoggerService {
  private write(level: string, message: unknown, context?: string, extra?: Record<string, unknown>) {
    const ctx = currentContext();
    const entry = {
      ts: new Date().toISOString(),
      level,
      context,
      msg: typeof message === 'string' ? message : (redact(message) as unknown),
      requestId: ctx?.requestId,
      userId: ctx?.user?.id,
      ...(extra ? (redact(extra) as Record<string, unknown>) : {}),
    };
    const line = JSON.stringify(entry);
    if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  }

  log(message: unknown, context?: string) {
    this.write('info', message, context);
  }
  error(message: unknown, trace?: string, context?: string) {
    this.write('error', message, context, trace ? { trace: trace.split('\n').slice(0, 6).join(' | ') } : undefined);
  }
  warn(message: unknown, context?: string) {
    this.write('warn', message, context);
  }
  debug(message: unknown, context?: string) {
    if (process.env.LOG_LEVEL === 'debug') this.write('debug', message, context);
  }
  verbose(message: unknown, context?: string) {
    if (process.env.LOG_LEVEL === 'debug') this.write('verbose', message, context);
  }
  event(message: string, extra: Record<string, unknown>) {
    this.write('info', message, 'http', extra);
  }
}

export const logger = new JsonLogger();
