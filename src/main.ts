import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './shared/filters/http-exception.filter';
import { ResponseInterceptor } from './shared/interceptors/response.interceptor';
import { validateEnv } from './config/env.validation';
import { securityHeaders } from './shared/middleware/security-headers';

async function bootstrap() {
  validateEnv();

  // rawBody is needed to verify the payment provider's webhook signature.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });

  // Render (and most hosts) put a proxy in front of the app. Trusting one hop
  // makes rate limiting count each client's real IP instead of the proxy's.
  app.set('trust proxy', 1);

  // Don't announce the framework, and send basic protective headers.
  app.disable('x-powered-by');
  app.use(securityHeaders(process.env.NODE_ENV === 'production'));

  const origins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors(origins.length > 0 ? { origin: origins } : undefined);

  app.setGlobalPrefix('api/v1');

  // Every request is validated before it reaches business logic
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Standardized error responses regardless of which module threw
  app.useGlobalFilters(new HttpExceptionFilter());

  // Standardized success response envelope
  app.useGlobalInterceptors(new ResponseInterceptor());

  const port = process.env.PORT || 3000;
  await app.listen(port);
  new Logger('Bootstrap').log(`Backend running on port ${port} (/api/v1)`);
}
bootstrap();
