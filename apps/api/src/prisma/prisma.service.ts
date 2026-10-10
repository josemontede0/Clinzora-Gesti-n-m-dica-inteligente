import { Global, Injectable, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

export type Tx = Prisma.TransactionClient;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    // Los errores de consulta los maneja el filtro global (que registra los 5xx); aquí solo advertencias.
    super({ log: [{ level: 'warn', emit: 'stdout' }] });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /** Transacción con aislamiento SERIALIZABLE y reintento ante conflictos de serialización (40001). */
  async serializable<T>(fn: (tx: Tx) => Promise<T>, retries = 3): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000 });
      } catch (e) {
        const code = (e as { code?: string }).code;
        const isConflict = code === 'P2034' || String((e as Error).message).includes('40001');
        if (!isConflict || attempt >= retries) throw e;
        await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
      }
    }
  }
}

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
