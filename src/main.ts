import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { json } from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: true, bodyParser: false });

  // Custom body parser that stashes the raw bytes on the request.
  // Monnify signs the exact raw JSON body, so we need those exact bytes
  // (not a re-serialized object) to verify the webhook signature correctly.
  app.use(
    json({
      verify: (req: any, _res, buf: Buffer) => {
        req.rawBody = buf;
      },
    }),
  );

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );
  const port = process.env.PORT || 3000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`MatchPay backend running on http://localhost:${port}`);
}
bootstrap();
