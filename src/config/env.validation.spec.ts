import { parseOrigins, validate } from './env.validation';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  CORS_ORIGINS: 'http://localhost:3000',
  FRONTEND_URL: 'http://localhost:3000',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
};

describe('env validation', () => {
  it('applies defaults and converts types', () => {
    const env = validate({ ...valid, PORT: '4000', COOKIE_SECURE: 'false' });
    expect(env.PORT).toBe(4000);
    expect(env.COOKIE_SECURE).toBe(false);
    expect(env.JWT_ACCESS_TTL_SECONDS).toBe(900);
    expect(env.COOKIE_SAMESITE).toBe('strict');
  });

  it('reports every missing required variable in one error', () => {
    expect(() => validate({})).toThrow(/DATABASE_URL[\s\S]*JWT_ACCESS_SECRET/);
  });

  it('rejects short JWT secrets', () => {
    expect(() => validate({ ...valid, JWT_ACCESS_SECRET: 'short' })).toThrow(
      /at least 32 characters/,
    );
  });

  it('treats empty optional variables as unset', () => {
    const env = validate({ ...valid, SMTP_PORT: '', COOKIE_DOMAIN: '' });
    expect(env.SMTP_PORT).toBeUndefined();
    expect(env.COOKIE_DOMAIN).toBeUndefined();
  });

  it('requires SMTP settings when the smtp transport is selected', () => {
    expect(() => validate({ ...valid, MAIL_TRANSPORT: 'smtp' })).toThrow(
      /SMTP_HOST/,
    );
  });

  it('rejects malformed CORS origins', () => {
    expect(() =>
      validate({ ...valid, CORS_ORIGINS: 'localhost:3000' }),
    ).toThrow(/CORS_ORIGINS/);
  });

  it('enforces production safeguards', () => {
    expect(() => validate({ ...valid, NODE_ENV: 'production' })).toThrow(
      /COOKIE_SECURE must be true[\s\S]*MAIL_TRANSPORT must be smtp/,
    );
  });

  it('requires secure cookies for SameSite=none', () => {
    expect(() => validate({ ...valid, COOKIE_SAMESITE: 'none' })).toThrow(
      /COOKIE_SECURE=true/,
    );
  });

  it('accepts a complete production configuration', () => {
    const env = validate({
      ...valid,
      NODE_ENV: 'production',
      FRONTEND_URL: 'https://admin.example.com',
      CORS_ORIGINS: 'https://admin.example.com',
      COOKIE_SECURE: 'true',
      MAIL_TRANSPORT: 'smtp',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '587',
    });
    expect(env.SMTP_PORT).toBe(587);
  });
});

describe('parseOrigins', () => {
  it('normalizes entries and drops invalid ones', () => {
    expect(
      parseOrigins('http://localhost:3000/, https://a.example.com ,nope'),
    ).toEqual(['http://localhost:3000', 'https://a.example.com']);
  });
});
