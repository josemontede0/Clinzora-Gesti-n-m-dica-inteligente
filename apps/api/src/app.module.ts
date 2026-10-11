import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { AuditModule } from './common/audit.service';
import { ClinicalAccessModule } from './common/clinical-access';
import { requestContext } from './common/context';
import { AllExceptionsFilter } from './common/errors';
import { logger } from './common/logger';
import { PrismaModule } from './prisma/prisma.service';
import { AuthModule } from './modules/auth/auth.module';
import { CsrfGuard, PermissionsGuard, SessionGuard } from './modules/auth/guards';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { PatientsModule } from './modules/patients/patients.module';
import { SettingsModule } from './modules/settings/settings.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { AppointmentsModule } from './modules/appointments/appointments.module';
import { ClinicalModule } from './modules/clinical/clinical.module';
import { BillingModule } from './modules/billing/billing.module';
import { InsuranceModule } from './modules/insurance/insurance.module';
import { ReportsModule } from './modules/reports/reports.module';
import { FilesModule } from './modules/files/files.module';
import { UsersModule } from './modules/users/users.module';
import { QueueModule } from './modules/queue/queue.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 300 }]),
    PrismaModule,
    AuditModule,
    ClinicalAccessModule,
    SettingsModule,
    NotificationsModule,
    AuthModule,
    UsersModule,
    PatientsModule,
    CatalogModule,
    AppointmentsModule,
    ClinicalModule,
    BillingModule,
    InsuranceModule,
    ReportsModule,
    FilesModule,
    QueueModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Orden: límite de solicitudes → CSRF → sesión → permisos.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((req: Request, res: Response, next: NextFunction) => {
        const requestId = (req.get('x-request-id') ?? '').slice(0, 64) || randomUUID();
        res.setHeader('x-request-id', requestId);
        const started = Date.now();
        requestContext.run({ requestId, ip: req.ip, userAgent: req.get('user-agent') }, () => {
          res.on('finish', () => {
            // Solo método, ruta sin query string, estado y duración: sin datos personales.
            logger.event('request', { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started });
          });
          next();
        });
      })
      .forRoutes('*');
  }
}
