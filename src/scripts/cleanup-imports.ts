import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { ImportsService } from '../imports/imports.service';

async function main() {
  const context = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  try {
    const result = await context.get(ImportsService).cleanup();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await context.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Import cleanup failed: ${error instanceof Error ? error.message : 'Unknown error'}\n`,
  );
  process.exitCode = 1;
});
