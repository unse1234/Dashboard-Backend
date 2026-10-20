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
    expect(env.UPLOAD_DIR).toBe('./uploads');
  });

  it('gives a checkout quote 30 minutes unless told otherwise, within limits', () => {
    expect(validate(valid).QUOTE_TTL_MINUTES).toBe(30);
    expect(
      validate({ ...valid, QUOTE_TTL_MINUTES: '5' }).QUOTE_TTL_MINUTES,
    ).toBe(5);
    expect(() => validate({ ...valid, QUOTE_TTL_MINUTES: '0' })).toThrow(
      /QUOTE_TTL_MINUTES/,
    );
    expect(() => validate({ ...valid, QUOTE_TTL_MINUTES: '1441' })).toThrow(
      /QUOTE_TTL_MINUTES/,
    );
  });

  it('requires finite, positive database deadlines and converts overrides', () => {
    const defaults = validate(valid);
    expect(defaults.DB_CONNECTION_TIMEOUT_MS).toBe(5000);
    expect(defaults.DB_QUERY_TIMEOUT_MS).toBe(10000);
    const custom = validate({
      ...valid,
      DB_CONNECTION_TIMEOUT_MS: '3000',
      DB_QUERY_TIMEOUT_MS: '15000',
    });
    expect(custom.DB_CONNECTION_TIMEOUT_MS).toBe(3000);
    expect(custom.DB_QUERY_TIMEOUT_MS).toBe(15000);
    for (const key of ['DB_CONNECTION_TIMEOUT_MS', 'DB_QUERY_TIMEOUT_MS']) {
      for (const value of ['0', '-1', 'invalid', '120001']) {
        expect(() => validate({ ...valid, [key]: value })).toThrow(key);
      }
    }
  });

  it('keeps order confirmation off unless switched on, with a 60-minute deadline', () => {
    const defaults = validate(valid);
    expect(defaults.ORDER_CONFIRMATION_ENABLED).toBe(false);
    expect(defaults.ORDER_CONFIRMATION_TTL_MINUTES).toBe(60);
    const on = validate({
      ...valid,
      ORDER_CONFIRMATION_ENABLED: 'true',
      ORDER_CONFIRMATION_TTL_MINUTES: '30',
    });
    expect(on.ORDER_CONFIRMATION_ENABLED).toBe(true);
    expect(on.ORDER_CONFIRMATION_TTL_MINUTES).toBe(30);
    expect(
      validate({ ...valid, ORDER_CONFIRMATION_ENABLED: 'false' })
        .ORDER_CONFIRMATION_ENABLED,
    ).toBe(false);
    for (const value of ['9', '1441', 'soon']) {
      expect(() =>
        validate({ ...valid, ORDER_CONFIRMATION_TTL_MINUTES: value }),
      ).toThrow(/ORDER_CONFIRMATION_TTL_MINUTES/);
    }
    expect(() =>
      validate({ ...valid, ORDER_CONFIRMATION_ENABLED: 'yes' }),
    ).toThrow(/ORDER_CONFIRMATION_ENABLED/);
  });

  it('keeps storefront accounts off, and only allows them with order confirmation', () => {
    const defaults = validate(valid);
    expect(defaults.STOREFRONT_ACCOUNTS_ENABLED).toBe(false);
    expect(defaults.ACCOUNT_SETUP_TTL_MINUTES).toBe(15);
    expect(() =>
      validate({ ...valid, STOREFRONT_ACCOUNTS_ENABLED: 'true' }),
    ).toThrow(
      /STOREFRONT_ACCOUNTS_ENABLED=true requires ORDER_CONFIRMATION_ENABLED=true/,
    );
    expect(
      validate({
        ...valid,
        STOREFRONT_ACCOUNTS_ENABLED: 'true',
        ORDER_CONFIRMATION_ENABLED: 'true',
      }).STOREFRONT_ACCOUNTS_ENABLED,
    ).toBe(true);
    for (const value of ['4', '61']) {
      expect(() =>
        validate({ ...valid, ACCOUNT_SETUP_TTL_MINUTES: value }),
      ).toThrow(/ACCOUNT_SETUP_TTL_MINUTES/);
    }
  });

  it('gives storefront sessions their own lifetimes, within limits', () => {
    const defaults = validate(valid);
    expect(defaults.STOREFRONT_ACCESS_TTL_SECONDS).toBe(900);
    expect(defaults.STOREFRONT_SESSION_TTL_DAYS).toBe(30);
    expect(
      validate({ ...valid, STOREFRONT_SESSION_TTL_DAYS: '14' })
        .STOREFRONT_SESSION_TTL_DAYS,
    ).toBe(14);
    for (const [key, value] of [
      ['STOREFRONT_ACCESS_TTL_SECONDS', '59'],
      ['STOREFRONT_ACCESS_TTL_SECONDS', '3601'],
      ['STOREFRONT_SESSION_TTL_DAYS', '0'],
      ['STOREFRONT_SESSION_TTL_DAYS', '91'],
    ]) {
      expect(() => validate({ ...valid, [key]: value })).toThrow(
        new RegExp(key),
      );
    }
  });

  it('refuses the storefront token audience as the staff one', () => {
    expect(() =>
      validate({ ...valid, JWT_AUDIENCE: 'ecom-dash-storefront' }),
    ).toThrow(/JWT_AUDIENCE must not be "ecom-dash-storefront"/);
  });

  it('takes an optional storefront URL for shopper links, https in production', () => {
    expect(validate(valid).STOREFRONT_URL).toBeUndefined();
    expect(
      validate({ ...valid, STOREFRONT_URL: '' }).STOREFRONT_URL,
    ).toBeUndefined();
    expect(
      validate({ ...valid, STOREFRONT_URL: 'http://localhost:3000/shop' })
        .STOREFRONT_URL,
    ).toBe('http://localhost:3000/shop');
    for (const value of [
      'not a url',
      'ftp://shop.example',
      'https://shop.example/?ref=1',
      'https://shop.example/#x',
      'https://user:pass@shop.example',
    ]) {
      expect(() => validate({ ...valid, STOREFRONT_URL: value })).toThrow(
        /STOREFRONT_URL/,
      );
    }
  });

  it('reports every missing required variable in one error', () => {
    expect(() => validate({})).toThrow(/DATABASE_URL[\s\S]*JWT_ACCESS_SECRET/);
  });

  it('validates timing settings and supports disabling or logging all requests', () => {
    expect(validate(valid).REQUEST_TIMING_ENABLED).toBe(true);
    expect(validate(valid).SLOW_REQUEST_THRESHOLD_MS).toBe(500);
    const configured = validate({
      ...valid,
      REQUEST_TIMING_ENABLED: 'false',
      SLOW_REQUEST_THRESHOLD_MS: '0',
    });
    expect(configured.REQUEST_TIMING_ENABLED).toBe(false);
    expect(configured.SLOW_REQUEST_THRESHOLD_MS).toBe(0);
    expect(() =>
      validate({ ...valid, SLOW_REQUEST_THRESHOLD_MS: '-1' }),
    ).toThrow(/SLOW_REQUEST_THRESHOLD_MS/);
    expect(() =>
      validate({ ...valid, REQUEST_TIMING_ENABLED: 'invalid' }),
    ).toThrow(/REQUEST_TIMING_ENABLED/);
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

  it('rejects a cookie domain that is not a domain name', () => {
    expect(() =>
      validate({ ...valid, COOKIE_DOMAIN: 'a9b8db1464f3e5e2b3771d7f73dbbf73' }),
    ).toThrow(/COOKIE_DOMAIN must be a domain name/);
    expect(
      validate({ ...valid, COOKIE_DOMAIN: 'example.com' }).COOKIE_DOMAIN,
    ).toBe('example.com');
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

  it('requires an https storefront URL in production', () => {
    const production = {
      ...valid,
      NODE_ENV: 'production',
      PUBLIC_API_URL: 'https://api.example.com',
      FRONTEND_URL: 'https://admin.example.com',
      COOKIE_SECURE: 'true',
      MAIL_TRANSPORT: 'smtp',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '587',
    };
    expect(() =>
      validate({ ...production, STOREFRONT_URL: 'http://shop.example.com' }),
    ).toThrow(/STOREFRONT_URL must use https in production/);
    expect(
      validate({ ...production, STOREFRONT_URL: 'https://shop.example.com' })
        .STOREFRONT_URL,
    ).toBe('https://shop.example.com');
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
      PUBLIC_API_URL: 'https://api.example.com',
      FRONTEND_URL: 'https://admin.example.com',
      CORS_ORIGINS: 'https://admin.example.com',
      COOKIE_SECURE: 'true',
      MAIL_TRANSPORT: 'smtp',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '587',
    });
    expect(env.SMTP_PORT).toBe(587);
  });

  it('validates upload storage and its public origin', () => {
    expect(
      validate({
        ...valid,
        UPLOAD_DIR: '/var/data/uploads',
        PUBLIC_API_URL: 'https://api.example.com/',
      }).UPLOAD_DIR,
    ).toBe('/var/data/uploads');
    for (const value of [
      'ftp://example.com',
      'https://user:password@example.com',
      'https://api.example.com/path',
      'https://api.example.com?x=1',
      'https://api.example.com#x',
    ]) {
      expect(() => validate({ ...valid, PUBLIC_API_URL: value })).toThrow(
        'PUBLIC_API_URL',
      );
    }
    expect(() => validate({ ...valid, UPLOAD_DIR: '' })).toThrow('UPLOAD_DIR');
  });
});

describe('parseOrigins', () => {
  it('normalizes entries and drops invalid ones', () => {
    expect(
      parseOrigins('http://localhost:3000/, https://a.example.com ,nope'),
    ).toEqual(['http://localhost:3000', 'https://a.example.com']);
  });
});
