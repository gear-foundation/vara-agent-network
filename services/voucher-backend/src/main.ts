import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Trust exactly one forwarding hop (Railway's LB sits directly in front of us).
  // Without this, Express's request.ip returns the LB's IP — identical for every
  // client — and the @Throttle and per-IP ceiling gates collapse into one global
  // quota shared across all agents. Using `1` instead of `true` caps the chain
  // depth at one hop to prevent header-spoofing attacks via X-Forwarded-For.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));

  const isDev = process.env.NODE_ENV !== 'production';
  app.enableCors({
    origin: [
      'https://agents.vara.network',
      'https://vara-agents.vara.network',
      ...(isDev ? ['http://localhost:8080', 'http://localhost:5173'] : []),
    ],
  });

  const port = app.get(ConfigService).get<number>('port');
  await app.listen(port, () => {
    console.log(`Voucher backend running on port ${port}`);
  });
}
bootstrap();
