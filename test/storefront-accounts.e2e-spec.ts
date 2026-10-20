import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { EmailOutboxDispatcher } from '../src/email-outbox/email-outbox.dispatcher';
import { StorefrontAccountEmails } from '../src/email-outbox/storefront-account-emails';
import { OrderConfirmationSettings } from '../src/orders/storefront/order-confirmation.settings';
import {
  checkStorefrontToken,
  issueStorefrontToken,
} from '../src/storefront-tokens/storefront-tokens';
import {
  bearer,
  createCustomer,
  createOrder,
  createProduct,
  createTestApp,
  createUser,
  csrfHeaders,
  login,
  resetDatabase,
  TEST_PASSWORD,
  tokenFrom,
  waitForMail,
  type TestContext,
} from './helpers';

jest.setTimeout(60_000);

const HOUR_MS = 60 * 60 * 1000;
const PASSWORD = 'Shopper-Passw0rd';
const NEW_PASSWORD = 'Another-Passw0rd';
const ADDRESS = {
  recipientName: 'Ayesha Khan',
  phone: '0300 1234567',
  addressLine1: 'House 12, Street 4, F-7/2',
  addressLine2: null,
  city: 'Islamabad',
  region: 'Islamabad Capital Territory',
  postalCode: '44000',
  country: 'PK',
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually<T>(
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`condition not met: ${JSON.stringify(value)}`);
    }
    await sleep(25);
  }
}

const setCookies = (res: request.Response): string[] => {
  const header = res.headers['set-cookie'] as string[] | string | undefined;
  return Array.isArray(header) ? header : header ? [header] : [];
};

/** The "sf_refresh_token=<value>" pair a response set, if any. */
const storefrontCookie = (res: request.Response): string | undefined =>
  setCookies(res)
    .find(
      (c) =>
        c.startsWith('sf_refresh_token=') &&
        !c.startsWith('sf_refresh_token=;'),
    )
    ?.split(';')[0];

const clearsStorefrontCookie = (res: request.Response): boolean =>
  setCookies(res).some(
    (c) =>
      c.startsWith('sf_refresh_token=;') && /expires=Thu, 01 Jan 1970/i.test(c),
  );

interface AuthBody {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  account: { email: string; createdAt: string };
}

/**
 * Storefront accounts over HTTP: setup from a verified permission, sign-in,
 * refresh rotation, sign-out, recovery, new setup links, and the separation
 * from staff authentication in both directions.
 */
describe('Storefront accounts (e2e)', () => {
  let ctx: TestContext;
  let seq = 0;
  // Mutable on purpose: a test may switch accounts off, afterEach restores.
  const settings = {
    enabled: true,
    ttlMs: HOUR_MS,
    accountsEnabled: true,
    accountSetupTtlMs: 15 * 60_000,
  };

  beforeAll(async () => {
    ctx = await createTestApp((builder) =>
      builder.overrideProvider(OrderConfirmationSettings).useValue(settings),
    );
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    // No after-commit send of the previous test may still be running.
    await eventually(
      () =>
        ctx.prisma.emailJob.count({ where: { attemptToken: { not: null } } }),
      (leased) => leased === 0,
    );
    await resetDatabase(ctx.prisma);
    ctx.mail.clear();
  });

  afterEach(() => {
    settings.accountsEnabled = true;
  });

  const http = () => request(ctx.app.getHttpServer());
  const db = () => ctx.prisma;

  const previewSetup = (setupToken: unknown) =>
    http().post('/storefront/account/setup/preview').send({ setupToken });
  const setup = (
    setupToken: unknown,
    password = PASSWORD,
    extra: Record<string, unknown> = {},
  ) =>
    http()
      .post('/storefront/account/setup')
      .send({ setupToken, password, confirmPassword: password, ...extra });
  const signIn = (email: string, password = PASSWORD) =>
    http().post('/storefront/account/session').send({ email, password });
  const refresh = (cookie: string) =>
    http()
      .post('/storefront/account/session/refresh')
      .set(csrfHeaders)
      .set('Cookie', cookie);
  const signOut = (cookie: string) =>
    http()
      .post('/storefront/account/session/sign-out')
      .set(csrfHeaders)
      .set('Cookie', cookie);
  const me = (accessToken: string) =>
    http().get('/storefront/account/me').set(bearer(accessToken));
  const forgot = (email: string) =>
    http().post('/storefront/account/password/forgot').send({ email });
  const reset = (token: unknown, password = NEW_PASSWORD) =>
    http()
      .post('/storefront/account/password/reset')
      .send({ token, password, confirmPassword: password });
  const requestSetupLink = (body: Record<string, unknown>) =>
    http().post('/storefront/account/setup-link').send(body);

  const nextEmail = () => {
    seq += 1;
    return `shopper${seq}@example.com`;
  };

  /** The address's customer record (one per address), made on first use. */
  const customerFor = async (email: string) =>
    (await db().customer.findUnique({ where: { email } })) ??
    createCustomer(db(), { email });

  /** An order confirmed through `email`'s inbox (not owned by any account). */
  const confirmedOrder = async (email: string) => {
    const customer = await customerFor(email);
    const now = Date.now();
    return createOrder(db(), customer, {
      status: 'PENDING',
      confirmation: {
        status: 'CONFIRMED',
        email,
        expiresAt: new Date(now + HOUR_MS),
        confirmedAt: new Date(now - 1000),
      },
    });
  };

  /** A setup permission, as confirming the order would have issued it. */
  const grant = async (email: string, orderId?: string) => {
    const order = orderId ?? (await confirmedOrder(email)).id;
    const issued = await issueStorefrontToken(db(), {
      purpose: 'ACCOUNT_SETUP',
      orderId: order,
      email,
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    return issued.token;
  };

  /** An account with PASSWORD, signed in; returns its session. */
  const account = async (email = nextEmail()) => {
    const res = await setup(await grant(email)).expect(201);
    const cookie = storefrontCookie(res);
    if (!cookie) throw new Error('setup set no cookie');
    return { email, cookie, accessToken: (res.body as AuthBody).accessToken };
  };

  /** Lets the account-email cooldown pass, as if the last email were a minute old. */
  const ageAccountEmails = (recipient: string) =>
    db().emailJob.updateMany({
      where: { recipient },
      data: { createdAt: new Date(Date.now() - 61_000) },
    });

  describe('account setup', () => {
    it('creates the account from a confirmation, for the confirmed address, and signs it in', async () => {
      const product = await createProduct(db(), {
        currency: 'PKR',
        price: '1500.00',
        stock: 5,
      });
      const email = nextEmail();
      const items = [{ productId: `PRD-${product.number}`, quantity: 1 }];
      const quote = await http()
        .post('/storefront/checkout/quote')
        .send({ items, shippingAddress: ADDRESS })
        .expect(200);
      await http()
        .post('/storefront/orders')
        .set('Idempotency-Key', randomUUID())
        .send({
          contact: { name: 'Ayesha Khan', email, phone: '0300 1234567' },
          items,
          shippingAddress: ADDRESS,
          quoteToken: (quote.body as { quoteToken: string }).quoteToken,
        })
        .expect(201);
      const [message] = await waitForMail(ctx.mail, email);
      const confirmed = await http()
        .post('/storefront/order-confirmations/confirm')
        .send({ token: tokenFrom(message) })
        .expect(200);
      const { setupToken } = (
        confirmed.body as { account: { setupToken: string } }
      ).account;

      const preview = await previewSetup(setupToken).expect(200);
      expect(preview.body).toEqual({
        status: 'READY',
        email,
        expiresAt: expect.any(String),
      });
      // Previewing used nothing.
      await expect(
        checkStorefrontToken(db(), setupToken, 'ACCOUNT_SETUP'),
      ).resolves.toMatchObject({ status: 'valid' });

      const res = await setup(setupToken).expect(201);
      const body = res.body as AuthBody;
      expect(body).toEqual({
        accessToken: expect.any(String),
        tokenType: 'Bearer',
        expiresIn: 900,
        account: { email, createdAt: expect.any(String) },
      });
      const raw = setCookies(res).find((c) =>
        c.startsWith('sf_refresh_token='),
      );
      expect(raw).toMatch(/HttpOnly/i);
      expect(raw).toMatch(/Path=\/storefront\/account\/session(;|$)/);
      expect(raw).toMatch(/SameSite=Strict/i);
      expect(setCookies(res).some((c) => c.startsWith('refresh_token='))).toBe(
        false,
      );

      await me(body.accessToken)
        .expect(200)
        .expect({ email, createdAt: body.account.createdAt });

      const created = await db().storefrontAccount.findUniqueOrThrow({
        where: { email },
      });
      expect(created.passwordHash).toMatch(/^\$argon2id\$/);
      const order = await db().order.findFirstOrThrow({
        where: { confirmationEmail: email },
      });
      expect(order.storefrontAccountId).toBe(created.id);
      await expect(
        checkStorefrontToken(db(), setupToken, 'ACCOUNT_SETUP'),
      ).resolves.toMatchObject({ status: 'used' });
    });

    it('takes the address only from the permission: an email field is refused', async () => {
      const email = nextEmail();
      const token = await grant(email);
      await setup(token, PASSWORD, { email: 'attacker@example.com' }).expect(
        400,
      );
      expect(await db().storefrontAccount.count()).toBe(0);
      await expect(
        checkStorefrontToken(db(), token, 'ACCOUNT_SETUP'),
      ).resolves.toMatchObject({ status: 'valid' });
    });

    it('checks the password and its confirmation on the server, using nothing on a refusal', async () => {
      const token = await grant(nextEmail());

      const mismatch = await http()
        .post('/storefront/account/setup')
        .send({
          setupToken: token,
          password: PASSWORD,
          confirmPassword: `${PASSWORD}x`,
        })
        .expect(400);
      expect(mismatch.body).toMatchObject({ code: 'PASSWORD_MISMATCH' });
      await setup(token, 'short').expect(400);
      await setup(token, 'alllowercase-and-long').expect(400);

      expect(await db().storefrontAccount.count()).toBe(0);
      await expect(
        checkStorefrontToken(db(), token, 'ACCOUNT_SETUP'),
      ).resolves.toMatchObject({ status: 'valid' });
    });

    it('works once: a replayed permission creates nothing and changes no password', async () => {
      const email = nextEmail();
      const token = await grant(email);
      await setup(token).expect(201);

      const replay = await setup(token, NEW_PASSWORD).expect(404);
      expect(replay.body).toMatchObject({ code: 'SETUP_TOKEN_INVALID' });
      await previewSetup(token).expect(404);
      expect(await db().storefrontAccount.count()).toBe(1);
      await signIn(email, PASSWORD).expect(200);
      await signIn(email, NEW_PASSWORD).expect(401);
    });

    it('refuses an unknown, malformed or wrong-purpose token alike', async () => {
      const email = nextEmail();
      const order = await confirmedOrder(email);
      const receipt = await issueStorefrontToken(db(), {
        purpose: 'CHECKOUT_RECEIPT',
        orderId: order.id,
        email,
        expiresAt: new Date(Date.now() + HOUR_MS),
      });
      for (const token of [
        `as_${'a'.repeat(43)}`,
        'as_short',
        receipt.token,
        receipt.token.replace(/^cr_/, 'as_'),
      ]) {
        const res = await previewSetup(token).expect(404);
        expect(res.body).toMatchObject({ code: 'SETUP_TOKEN_INVALID' });
        await setup(token).expect(404);
      }
      expect(await db().storefrontAccount.count()).toBe(0);
    });

    it('says when the permission ran out, and creates nothing', async () => {
      const token = await grant(nextEmail());
      await db().storefrontToken.updateMany({
        where: { purpose: 'ACCOUNT_SETUP' },
        data: {
          createdAt: new Date(Date.now() - 20 * 60_000),
          expiresAt: new Date(Date.now() - 1000),
        },
      });
      const preview = await previewSetup(token).expect(410);
      expect(preview.body).toMatchObject({ code: 'SETUP_TOKEN_EXPIRED' });
      const res = await setup(token).expect(410);
      expect(res.body).toMatchObject({ code: 'SETUP_TOKEN_EXPIRED' });
      expect(await db().storefrontAccount.count()).toBe(0);
    });

    it('never overwrites an existing account: sign in or recover instead', async () => {
      const { email } = await account();
      const second = await grant(email);

      await previewSetup(second)
        .expect(200)
        .expect((res) =>
          expect(res.body).toMatchObject({ status: 'ACCOUNT_EXISTS', email }),
        );
      const res = await setup(second, NEW_PASSWORD).expect(409);
      expect(res.body).toMatchObject({ code: 'ACCOUNT_EXISTS' });
      expect(storefrontCookie(res)).toBeUndefined();

      await signIn(email, PASSWORD).expect(200);
      await signIn(email, NEW_PASSWORD).expect(401);
      expect(await db().storefrontAccount.count()).toBe(1);
    });

    it('lets exactly one of many simultaneous setups with one permission through', async () => {
      const email = nextEmail();
      const token = await grant(email);

      const results = await Promise.all(
        Array.from({ length: 6 }, () => setup(token)),
      );
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      // The others waited for the winner: they find its account (409), or
      // the token it used (404), depending on how far they had got.
      expect(
        statuses.filter((s) => s !== 201).every((s) => [404, 409].includes(s)),
      ).toBe(true);
      expect(await db().storefrontAccount.count({ where: { email } })).toBe(1);
      expect(await db().storefrontSession.count()).toBe(1);
    });

    it('creates one account when two permissions for one address race', async () => {
      const email = nextEmail();
      const order = await confirmedOrder(email);
      const first = await grant(email, order.id);
      const second = await grant(email, order.id);

      const [a, b] = await Promise.all([
        setup(first, PASSWORD),
        setup(second, NEW_PASSWORD),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect(await db().storefrontAccount.count()).toBe(1);
      const winner = a.status === 201 ? PASSWORD : NEW_PASSWORD;
      await signIn(email, winner).expect(200);
      // The loser's permission was not used by the refusal, but the winner's
      // setup voided every other permission for the address.
      const loser = a.status === 201 ? second : first;
      await expect(
        checkStorefrontToken(db(), loser, 'ACCOUNT_SETUP'),
      ).resolves.toMatchObject({ status: 'used' });
    });

    it("claims only the address's confirmed orders", async () => {
      const email = nextEmail();
      const confirmed = await confirmedOrder(email);
      const customer = await customerFor(email);
      const now = Date.now();
      const awaiting = await createOrder(db(), customer, {
        status: 'PENDING',
        confirmation: {
          status: 'AWAITING_CONFIRMATION',
          email,
          expiresAt: new Date(now + HOUR_MS),
        },
      });
      const expired = await createOrder(db(), customer, {
        status: 'CANCELLED',
        confirmation: {
          status: 'EXPIRED',
          email,
          expiresAt: new Date(now - 1000),
        },
      });
      // A legacy order to the same address proves nothing about the inbox.
      const exempt = await createOrder(db(), customer);
      const elsewhere = await confirmedOrder(nextEmail());

      await setup(await grant(email, confirmed.id)).expect(201);
      const owner = await db().storefrontAccount.findUniqueOrThrow({
        where: { email },
      });
      const owned = await db().order.findMany({
        where: { storefrontAccountId: owner.id },
        select: { id: true },
      });
      expect(owned.map((o) => o.id)).toEqual([confirmed.id]);
      for (const other of [awaiting, expired, exempt, elsewhere]) {
        const row = await db().order.findUniqueOrThrow({
          where: { id: other.id },
        });
        expect(row.storefrontAccountId).toBeNull();
      }
    });
  });

  describe('sessions', () => {
    it('signs in with the same answer for every failure', async () => {
      const { email } = await account();

      const ok = await signIn(email).expect(200);
      expect((ok.body as AuthBody).account.email).toBe(email);
      expect(storefrontCookie(ok)).toBeDefined();
      const lastLogin = await db().storefrontAccount.findUniqueOrThrow({
        where: { email },
      });
      expect(lastLogin.lastLoginAt).not.toBeNull();

      const wrong = await signIn(email, NEW_PASSWORD).expect(401);
      const unknown = await signIn('nobody@example.com').expect(401);
      expect(wrong.body).toEqual(unknown.body);
      expect(wrong.body).toMatchObject({
        message: 'Invalid email or password',
      });
      // A staff account's credentials are not a shopper's.
      await createUser(db(), { email: 'staff@example.com' });
      await signIn('staff@example.com', TEST_PASSWORD).expect(401);
    });

    it('rotates the refresh token on every use and ends a session whose old token comes back', async () => {
      const session = await account();

      const first = await refresh(session.cookie).expect(200);
      const rotated = storefrontCookie(first);
      expect(rotated).toBeDefined();
      expect(rotated).not.toBe(session.cookie);
      await me((first.body as AuthBody).accessToken).expect(200);

      // A second tab that lost the race: refused, but the cookie is kept and
      // the session lives on.
      const race = await refresh(session.cookie).expect(401);
      expect(clearsStorefrontCookie(race)).toBe(false);
      const second = await refresh(rotated!).expect(200);
      const latest = storefrontCookie(second)!;

      // The old token again, after the grace period: theft is assumed and the
      // whole session ends, the latest token with it.
      await db().storefrontSession.updateMany({
        data: { rotatedAt: new Date(Date.now() - 31_000) },
      });
      const reuse = await refresh(rotated!).expect(401);
      expect(clearsStorefrontCookie(reuse)).toBe(true);
      await refresh(latest).expect(401);
      const row = await db().storefrontSession.findFirstOrThrow();
      expect(row.revokedReason).toBe('REUSE_DETECTED');
    });

    it('refreshes and signs out only with the CSRF defences', async () => {
      const session = await account();
      await http()
        .post('/storefront/account/session/refresh')
        .set('Cookie', session.cookie)
        .expect(403);
      await http()
        .post('/storefront/account/session/refresh')
        .set({ Origin: 'https://evil.example', 'X-CSRF-Protection': '1' })
        .set('Cookie', session.cookie)
        .expect(403);
      await http()
        .post('/storefront/account/session/sign-out')
        .set('Cookie', session.cookie)
        .expect(403);
      await refresh(session.cookie).expect(200);
    });

    it('signs out: the session ends, its access token with it', async () => {
      const session = await account();
      const res = await signOut(session.cookie).expect(204);
      expect(clearsStorefrontCookie(res)).toBe(true);
      await refresh(session.cookie).expect(401);
      await me(session.accessToken).expect(401);
      // Signing out without a session is harmless.
      await signOut('sf_refresh_token=nonsense').expect(204);
    });

    it('needs a valid storefront access token for the account', async () => {
      await http().get('/storefront/account/me').expect(401);
      await me('not-a-token').expect(401);
      await refresh('sf_refresh_token=nonsense').expect(401);
      await http()
        .post('/storefront/account/session/refresh')
        .set(csrfHeaders)
        .expect(401);
    });
  });

  describe('separation from staff authentication', () => {
    it('refuses a shopper on every staff route family', async () => {
      const shopper = await account();
      for (const path of [
        '/auth/me',
        '/auth/sessions',
        '/orders',
        '/users',
        '/customers',
        '/products',
      ]) {
        await http().get(path).set(bearer(shopper.accessToken)).expect(401);
      }
      // A storefront refresh token is not a staff one, in either cookie.
      const value = shopper.cookie.split('=')[1];
      await http()
        .post('/auth/refresh')
        .set(csrfHeaders)
        .set('Cookie', `refresh_token=${value}`)
        .expect(401);
    });

    it('refuses staff credentials on the storefront account', async () => {
      await createUser(db(), { email: 'admin@example.com', role: 'ADMIN' });
      const staff = await login(ctx.app, 'admin@example.com');
      await me(staff.accessToken).expect(401);
      const value = staff.cookie.split('=')[1];
      await refresh(`sf_refresh_token=${value}`).expect(401);
      // Still a perfectly good staff session.
      await http().get('/auth/me').set(bearer(staff.accessToken)).expect(200);
    });
  });

  describe('password recovery', () => {
    it('answers alike for every address and emails only an account', async () => {
      const { email } = await account();

      const known = await forgot(email).expect(202);
      const unknown = await forgot('nobody@example.com').expect(202);
      expect(known.body).toEqual(unknown.body);

      const [message] = await waitForMail(ctx.mail, email);
      expect(message.subject).toBe('Reset your password');
      expect(message.text).toContain(
        'http://localhost:3000/account/reset-password#token=pr_',
      );
      await sleep(100);
      expect(ctx.mail.to('nobody@example.com')).toHaveLength(0);
      const job = await db().emailJob.findFirstOrThrow({
        where: { recipient: email },
      });
      expect(job).toMatchObject({
        type: 'STOREFRONT_PASSWORD_RESET',
        status: 'SENT',
        protectedPayload: null,
      });
    });

    it('resets once, signs every session out, and the old password stops working', async () => {
      const session = await account();
      await forgot(session.email).expect(202);
      const token = tokenFrom((await waitForMail(ctx.mail, session.email))[0]);

      const mismatch = await http()
        .post('/storefront/account/password/reset')
        .send({ token, password: NEW_PASSWORD, confirmPassword: PASSWORD })
        .expect(400);
      expect(mismatch.body).toMatchObject({ code: 'PASSWORD_MISMATCH' });

      await reset(token).expect(200);
      await signIn(session.email, PASSWORD).expect(401);
      await signIn(session.email, NEW_PASSWORD).expect(200);
      await refresh(session.cookie).expect(401);
      await me(session.accessToken).expect(401);

      const replay = await reset(token, 'Third-Passw0rd!').expect(400);
      expect(replay.body).toMatchObject({ code: 'RESET_TOKEN_INVALID' });
      await signIn(session.email, NEW_PASSWORD).expect(200);
    });

    it('keeps only the newest link working, and limits how often one is sent', async () => {
      const { email } = await account();
      await forgot(email).expect(202);
      const older = tokenFrom((await waitForMail(ctx.mail, email))[0]);

      // Within the cooldown: the same answer, no email.
      await forgot(email).expect(202);
      await sleep(100);
      expect(ctx.mail.to(email)).toHaveLength(1);

      await ageAccountEmails(email);
      await forgot(email).expect(202);
      const newer = tokenFrom((await waitForMail(ctx.mail, email, 2))[1]);
      expect(newer).not.toBe(older);

      await reset(older).expect(400);
      await reset(newer).expect(200);
    });

    it('stops at the daily limit, counted in the database', async () => {
      const { email } = await account();
      for (let i = 0; i < 5; i++) {
        await forgot(email).expect(202);
        await waitForMail(ctx.mail, email, i + 1);
        await ageAccountEmails(email);
      }
      await forgot(email).expect(202);
      await sleep(150);
      expect(ctx.mail.to(email)).toHaveLength(5);
    });

    it('refuses unknown, malformed and wrong-purpose reset tokens alike', async () => {
      const { email } = await account();
      const setupToken = await grant(email);
      for (const token of [`pr_${'a'.repeat(43)}`, 'pr_x', setupToken]) {
        const res = await reset(token).expect(400);
        expect(res.body).toMatchObject({ code: 'RESET_TOKEN_INVALID' });
      }
    });
  });

  describe('a new setup link', () => {
    it('emails one to an address with a confirmed order and no account, which then sets up', async () => {
      const email = nextEmail();
      await confirmedOrder(email);

      const res = await requestSetupLink({ email }).expect(202);
      const [message] = await waitForMail(ctx.mail, email);
      expect(message.subject).toBe('Set up your account');
      expect(message.text).toContain(
        'http://localhost:3000/account/setup#token=as_',
      );
      const token = tokenFrom(message);
      await previewSetup(token)
        .expect(200)
        .expect((r) =>
          expect(r.body).toMatchObject({ status: 'READY', email }),
        );
      await setup(token).expect(201);

      // Every other address gets the same answer, and nothing.
      const noOrder = await requestSetupLink({
        email: 'nobody@example.com',
      }).expect(202);
      const hasAccount = await requestSetupLink({ email }).expect(202);
      expect(noOrder.body).toEqual(res.body);
      expect(hasAccount.body).toEqual(res.body);
      await sleep(100);
      expect(ctx.mail.sent).toHaveLength(1);
    });

    it('sends one for the address of a permission that ran out', async () => {
      const email = nextEmail();
      const token = await grant(email);
      await db().storefrontToken.updateMany({
        where: { purpose: 'ACCOUNT_SETUP' },
        data: {
          createdAt: new Date(Date.now() - 20 * 60_000),
          expiresAt: new Date(Date.now() - 1000),
        },
      });
      await setup(token).expect(410);

      await requestSetupLink({ setupToken: token }).expect(202);
      const fresh = tokenFrom((await waitForMail(ctx.mail, email))[0]);
      expect(fresh).not.toBe(token);
      await setup(fresh).expect(201);

      // A token the shop does not know gets the same answer and nothing.
      await requestSetupLink({ setupToken: `as_${'z'.repeat(43)}` }).expect(
        202,
      );
      await requestSetupLink({}).expect(400);
      await requestSetupLink({ email, setupToken: token }).expect(400);
    });

    it('drops a queued link once the address has set up its account', async () => {
      const email = nextEmail();
      const order = await confirmedOrder(email);
      const emails = ctx.app.get(StorefrontAccountEmails);
      const { jobId } = await db().$transaction((tx) =>
        emails.enqueueSetupLink(tx, {
          email,
          orderId: order.id,
          expiresAt: new Date(Date.now() + HOUR_MS),
        }),
      );
      await setup(await grant(email, order.id)).expect(201);

      await expect(
        ctx.app.get(EmailOutboxDispatcher).dispatchJob(jobId),
      ).resolves.toBe('cancelled');
      const job = await db().emailJob.findUniqueOrThrow({
        where: { id: jobId },
      });
      expect(job).toMatchObject({
        status: 'CANCELLED',
        // Setting up voided every other permission for the address, the
        // queued link's included, so the email is not worth sending.
        failureCode: 'TOKEN_USED',
        protectedPayload: null,
      });
      expect(ctx.mail.to(email)).toHaveLength(0);
    });
  });

  it('is not there at all while accounts are switched off', async () => {
    const session = await account();
    settings.accountsEnabled = false;

    const calls: [string, () => request.Test][] = [
      ['POST /storefront/account/setup/preview', () => previewSetup('x')],
      ['POST /storefront/account/setup', () => setup('x')],
      [
        'POST /storefront/account/setup-link',
        () => requestSetupLink({ email: session.email }),
      ],
      ['POST /storefront/account/session', () => signIn(session.email)],
      [
        'POST /storefront/account/session/refresh',
        () => refresh(session.cookie),
      ],
      [
        'POST /storefront/account/session/sign-out',
        () => signOut(session.cookie),
      ],
      ['GET /storefront/account/me', () => me(session.accessToken)],
      ['POST /storefront/account/password/forgot', () => forgot(session.email)],
      ['POST /storefront/account/password/reset', () => reset('x')],
    ];
    for (const [route, call] of calls) {
      const res = await call().expect(404);
      expect(res.body).toMatchObject({ message: `Cannot ${route}` });
    }
    await sleep(100);
    expect(ctx.mail.sent).toHaveLength(0);
  });
});
