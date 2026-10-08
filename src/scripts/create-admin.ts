/**
 * One-time bootstrap of the first administrator.
 *
 *   npm run admin:create -- --email admin@example.com --name "Ada Admin"
 *
 * No password is accepted here or stored in any file: the account is created
 * without one and a set-password link is emailed (or, with MAIL_TRANSPORT=console
 * in development, printed). The command refuses to run once an active admin exists.
 */
import { NestFactory } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { parseArgs } from 'node:util';
import { AppModule } from '../app.module';
import { InviteUserDto } from '../users/dto/invite-user.dto';
import { UsersService } from '../users/users.service';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
    },
  });

  const input = plainToInstance(InviteUserDto, {
    email: values.email,
    name: values.name,
  });
  const problems = await validate(input, { whitelist: true });
  if (problems.length > 0) {
    const details = problems
      .flatMap((p) => Object.values(p.constraints ?? {}))
      .join('\n  - ');
    throw new Error(
      `Usage: npm run admin:create -- --email <address> --name "<full name>"\n  - ${details}`,
    );
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  try {
    const { user, invitationSent } = await app
      .get(UsersService)
      .bootstrapAdmin({ name: input.name, email: input.email });
    console.log(
      invitationSent
        ? `Admin ${user.email} created. A set-password link has been sent.`
        : `Admin ${user.email} created, but the email could not be sent. Check the mail settings, then use "Forgot password" to receive a link.`,
    );
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
