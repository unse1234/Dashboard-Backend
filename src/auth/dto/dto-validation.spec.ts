import { ValidationPipe } from '@nestjs/common';
import { ChangePasswordDto } from './change-password.dto';
import { LoginDto } from './login.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const run = <T>(type: new () => T, value: unknown) =>
  pipe.transform(value, { type: 'body', metatype: type });

describe('LoginDto', () => {
  it('trims and lowercases the email', async () => {
    const dto = await run(LoginDto, {
      email: '  Staff@Example.COM ',
      password: 'x',
    });
    expect(dto).toMatchObject({ email: 'staff@example.com', password: 'x' });
  });

  it.each([
    ['empty body', {}],
    ['bad email', { email: 'nope', password: 'x' }],
    ['empty password', { email: 'a@example.com', password: '' }],
    [
      'unknown property',
      { email: 'a@example.com', password: 'x', role: 'ADMIN' },
    ],
    [
      'password too long',
      { email: 'a@example.com', password: 'x'.repeat(129) },
    ],
    [
      'email too long',
      { email: `${'a'.repeat(250)}@example.com`, password: 'x' },
    ],
  ])('rejects %s', async (_name, body) => {
    await expect(run(LoginDto, body)).rejects.toMatchObject({ status: 400 });
  });
});

describe('ChangePasswordDto strength rules', () => {
  const ok = 'Abcdefghij1k';

  it('accepts a password meeting every rule', async () => {
    await expect(
      run(ChangePasswordDto, { currentPassword: 'old', newPassword: ok }),
    ).resolves.toMatchObject({ newPassword: ok });
  });

  it.each([
    ['too short', 'Abcdef1'],
    ['no uppercase', 'abcdefghij1k'],
    ['no lowercase', 'ABCDEFGHIJ1K'],
    ['no digit', 'Abcdefghijkl'],
    ['too long', `Aa1${'x'.repeat(126)}`],
  ])('rejects a password that is %s', async (_name, newPassword) => {
    await expect(
      run(ChangePasswordDto, { currentPassword: 'old', newPassword }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('does not trim or alter passwords', async () => {
    const padded = ` ${ok} `;
    await expect(
      run(ChangePasswordDto, { currentPassword: 'old', newPassword: padded }),
    ).resolves.toMatchObject({ newPassword: padded });
  });
});
