import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { config } from './config';
import { logger } from './common/logger';
import { AppModule } from './app.module';

export async function createApp() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger, rawBody: true });
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: config.isProduction ? undefined : false }));
  app.use(cookieParser());
  app.enableCors({ origin: config.WEB_ORIGIN, credentials: true });
  app.useBodyParser('json', { limit: '1mb' });
  app.enableShutdownHooks();

  if (!config.isProduction || config.SWAGGER_ENABLED) {
    const doc = new DocumentBuilder()
      .setTitle('MediGest API')
      .setDescription('API REST del Sistema Integral de Gestión Médica. Autenticación por cookie de sesión (mg_session). Las peticiones que modifican datos requieren la cabecera X-Requested-With: medigest.')
      .setVersion('0.1.0')
      .addCookieAuth('mg_session')
      .build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, doc));
  }
  return app;
}

async function bootstrap() {
  const app = await createApp();
  await app.listen(config.PORT, config.API_HOST);
  logger.log(`API escuchando en http://${config.API_HOST}:${config.PORT} (${config.NODE_ENV})`, 'Bootstrap');
}

if (require.main === module) {
  bootstrap().catch((e) => {
    logger.error(`No se pudo iniciar la API: ${(e as Error).message}`, (e as Error).stack, 'Bootstrap');
    process.exit(1);
  });
}
