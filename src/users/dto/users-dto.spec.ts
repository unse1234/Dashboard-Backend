import { ValidationPipe } from '@nestjs/common';
import {
  ForgotPasswordDto,
  ResetPasswordDto,
  VerifyEmailDto,
} from '../../auth/dto/recovery.dto';
import { InviteUserDto } from './invite-user.dto';
import { ListUsersQueryDto } from './list-users-query.dto';
import { UpdateUserDto } from './update-user.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const run = <T>(
  type: new () => T,
  value: unknown,
  kind: 'body' | 'query' = 'body',
) => pipe.transform(value, { type: kind, metatype: type });

const validToken = 'A'.repeat(43);

describe('InviteUserDto', () => {
  it('normalizes input and defaults the role to undefined (service applies STAFF)', async () => {
    await expect(
      run(InviteUserDto, { name: '  Sam  ', email: ' SAM@Example.com ' }),
    ).resolves.toMatchObject({ name: 'Sam', email: 'sam@example.com' });
  });

  it.each([
    [
      'a password',
      { name: 'S', email: 's@example.com', password: 'Abcdefghij1k' },
    ],
    ['an unknown role', { name: 'S', email: 's@example.com', role: 'OWNER' }],
    ['a blank name', { name: '  ', email: 's@example.com' }],
  ])('rejects %s', async (_label, body) => {
    await expect(run(InviteUserDto, body)).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('UpdateUserDto', () => {
  it('accepts partial updates and rejects email/credential fields', async () => {
    await expect(
      run(UpdateUserDto, { isActive: false }),
    ).resolves.toMatchObject({
      isActive: false,
    });
    for (const body of [
      { email: 'x@example.com' },
      { passwordHash: 'x' },
      { isActive: 'no' },
    ]) {
      await expect(run(UpdateUserDto, body)).rejects.toMatchObject({
        status: 400,
      });
    }
  });
});

describe('ListUsersQueryDto', () => {
  it('applies defaults and converts query strings', async () => {
    const dto = await run(ListUsersQueryDto, {}, 'query');
    expect(dto).toMatchObject({ page: 1, pageSize: 20 });

    const parsed = await run(
      ListUsersQueryDto,
      {
        page: '3',
        pageSize: '50',
        isActive: 'false',
        role: 'ADMIN',
        search: ' bob ',
      },
      'query',
    );
    expect(parsed).toMatchObject({
      page: 3,
      pageSize: 50,
      isActive: false,
      role: 'ADMIN',
      search: 'bob',
    });
  });

  it.each([
    { page: '0' },
    { pageSize: '101' },
    { page: '1.5' },
    { isActive: 'yes' },
  ])('rejects %p', async (query) => {
    await expect(run(ListUsersQueryDto, query, 'query')).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('recovery DTOs', () => {
  it('normalizes the forgot-password email', async () => {
    await expect(
      run(ForgotPasswordDto, { email: ' A@B.com ' }),
    ).resolves.toMatchObject({
      email: 'a@b.com',
    });
  });

  it('accepts base64url tokens and rejects anything else before it reaches the database', async () => {
    await expect(
      run(VerifyEmailDto, { token: validToken }),
    ).resolves.toBeDefined();
    for (const token of [
      '',
      'short',
      `${validToken}!`,
      `${validToken} x`,
      'A'.repeat(201),
      123,
    ]) {
      await expect(run(VerifyEmailDto, { token })).rejects.toMatchObject({
        status: 400,
      });
    }
  });

  it('applies the password policy to reset-password', async () => {
    await expect(
      run(ResetPasswordDto, {
        token: validToken,
        password: 'Valid-Passw0rd-1',
      }),
    ).resolves.toBeDefined();
    await expect(
      run(ResetPasswordDto, { token: validToken, password: 'weakpassword' }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
