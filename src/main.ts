import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { startLangfuseTracing, shutdownLangfuseTracing } from './observability/langfuse';

async function bootstrap() {
  startLangfuseTracing();
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  process.once('beforeExit', () => {
    shutdownLangfuseTracing();
  });
  app.enableCors({
    origin: true,
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
