import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import {
  MAIL_TRANSPORT,
  type MailMessage,
  type MailTransport,
} from '../src/mail/mail-transport';
import type {
  AddressType,
  OrderStatus,
  PaymentStatus,
  Role,
} from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';

export const ORIGIN = 'http://localhost:3000';
export const TEST_PASSWORD = 'Str0ng-Passw0rd!';

/** Headers a browser on the allowed dashboard origin would send to cookie endpoints. */
export const csrfHeaders = { Origin: ORIGIN, 'X-CSRF-Protection': '1' };

/** Captures outgoing email so tests can read the links the app would have sent. */
export class MemoryMailTransport implements MailTransport {
  readonly sent: MailMessage[] = [];

  send(message: MailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  to(email: string): MailMessage[] {
    return this.sent.filter((m) => m.to === email);
  }

  clear(): void {
    this.sent.length = 0;
  }
}

/** Pulls the single-use token out of the link in an email body. */
export function tokenFrom(message: MailMessage): string {
  const match = /token=([A-Za-z0-9_%-]+)/.exec(message.text);
  if (!match) throw new Error(`no token link in email: ${message.subject}`);
  return decodeURIComponent(match[1]);
}

/** Emails to forgot-password and resend are sent in the background; poll briefly. */
export async function waitForMail(
  mail: MemoryMailTransport,
  email: string,
  count = 1,
): Promise<MailMessage[]> {
  for (let i = 0; i < 100; i++) {
    if (mail.to(email).length >= count) return mail.to(email);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `expected ${count} email(s) to ${email}, got ${mail.to(email).length}`,
  );
}

export interface TestContext {
  app: NestExpressApplication;
  prisma: PrismaService;
  mail: MemoryMailTransport;
  close: () => Promise<void>;
}

export async function createTestApp(
  customize?: (builder: ReturnType<typeof Test.createTestingModule>) => void,
): Promise<TestContext> {
  const mail = new MemoryMailTransport();
  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MAIL_TRANSPORT)
    .useValue(mail);
  customize?.(builder);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.init();
  return {
    app,
    prisma: app.get(PrismaService),
    mail,
    close: () => app.close(),
  };
}

export async function resetDatabase(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Session", "PasswordResetToken", "EmailVerificationToken", "User", "OrderItem", "Order", "CustomerAddress", "Customer" CASCADE',
  );
}

let cachedHash: Promise<string> | undefined;
// Hashing is deliberately slow; share one hash across fixtures.
const testPasswordHash = () =>
  (cachedHash ??= argon2.hash(TEST_PASSWORD, { type: argon2.argon2id }));

export interface UserOptions {
  email?: string;
  name?: string;
  role?: Role;
  verified?: boolean;
  active?: boolean;
  /** Pass null to model an invited user who has not set a password yet. */
  password?: string | null;
}

export async function createUser(
  prisma: PrismaService,
  options: UserOptions = {},
) {
  const password =
    options.password === undefined ? TEST_PASSWORD : options.password;
  return prisma.user.create({
    data: {
      email: options.email ?? 'staff@example.com',
      name: options.name ?? 'Test User',
      role: options.role ?? 'STAFF',
      isActive: options.active ?? true,
      emailVerifiedAt: options.verified === false ? null : new Date(),
      passwordHash:
        password === null
          ? null
          : password === TEST_PASSWORD
            ? await testPasswordHash()
            : await argon2.hash(password, { type: argon2.argon2id }),
    },
  });
}

export interface LoginSession {
  accessToken: string;
  /** Full "refresh_token=..." pair, ready for a Cookie header. */
  cookie: string;
  sessionId: string;
}

export async function login(
  app: NestExpressApplication,
  email: string,
  password: string = TEST_PASSWORD,
): Promise<LoginSession> {
  const response = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password })
    .expect(200);
  const body = response.body as { accessToken: string };
  const cookie = refreshCookie(response);
  if (!cookie) throw new Error('login did not set a refresh cookie');
  return {
    accessToken: body.accessToken,
    cookie,
    sessionId: cookie.split('=')[1].split('.')[0],
  };
}

/** Extracts the "refresh_token=<value>" pair from a response's Set-Cookie headers. */
export function refreshCookie(response: request.Response): string | undefined {
  const header = response.headers['set-cookie'] as
    string[] | string | undefined;
  const cookies = Array.isArray(header) ? header : header ? [header] : [];
  const raw = cookies.find((c) => c.startsWith('refresh_token='));
  return raw?.split(';')[0];
}

/** True when the response instructs the browser to delete the refresh cookie. */
export function clearsRefreshCookie(response: request.Response): boolean {
  const header = response.headers['set-cookie'] as
    string[] | string | undefined;
  const cookies = Array.isArray(header) ? header : header ? [header] : [];
  return cookies.some(
    (c) =>
      c.startsWith('refresh_token=;') && /expires=Thu, 01 Jan 1970/i.test(c),
  );
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export interface CustomerOptions {
  name?: string;
  email?: string;
  phone?: string | null;
  createdAt?: Date;
}

let customerSeq = 0;

export function createCustomer(
  prisma: PrismaService,
  options: CustomerOptions = {},
) {
  customerSeq += 1;
  return prisma.customer.create({
    data: {
      name: options.name ?? `Customer ${customerSeq}`,
      email: options.email ?? `customer${customerSeq}@example.com`,
      phone: options.phone === undefined ? null : options.phone,
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    },
  });
}

export interface AddressOptions {
  type?: AddressType;
  isDefault?: boolean;
  recipientName?: string;
  city?: string;
  createdAt?: Date;
}

export function createAddress(
  prisma: PrismaService,
  customerId: string,
  options: AddressOptions = {},
) {
  return prisma.customerAddress.create({
    data: {
      customerId,
      type: options.type ?? 'SHIPPING',
      isDefault: options.isDefault ?? false,
      recipientName: options.recipientName ?? 'Test Recipient',
      phone: null,
      addressLine1: '1 Test Street',
      addressLine2: null,
      city: options.city ?? 'Springfield',
      region: null,
      postalCode: '12345',
      country: 'United States',
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    },
  });
}

export interface OrderOptions {
  /** The order total in USD (default 100). The subtotal is derived from it. */
  total?: number;
  shipping?: number;
  discount?: number;
  tax?: number;
  status?: OrderStatus;
  paymentStatus?: PaymentStatus;
  createdAt?: Date;
}

const testAddress = {
  recipientName: 'Test Recipient',
  phone: null,
  addressLine1: '1 Test Street',
  addressLine2: null,
  city: 'Springfield',
  region: null,
  postalCode: '12345',
  country: 'United States',
};

const toCents = (amount: number) => Math.round(amount * 100);
const fromCents = (cents: number) => (cents / 100).toFixed(2);

/**
 * Creates an order with one line whose amounts satisfy the database checks:
 * subtotal = total - shipping + discount - tax, and the line totals the subtotal.
 */
export function createOrder(
  prisma: PrismaService,
  customer: { id: string; name: string; email: string; phone: string | null },
  options: OrderOptions = {},
) {
  const total = toCents(options.total ?? 100);
  const shipping = toCents(options.shipping ?? 0);
  const discount = toCents(options.discount ?? 0);
  const tax = toCents(options.tax ?? 0);
  const subtotal = total - shipping + discount - tax;
  return prisma.order.create({
    data: {
      customerId: customer.id,
      customerName: customer.name,
      customerEmail: customer.email,
      customerPhone: customer.phone,
      status: options.status ?? 'DELIVERED',
      paymentStatus: options.paymentStatus ?? 'PAID',
      subtotal: fromCents(subtotal),
      shipping: fromCents(shipping),
      discount: fromCents(discount),
      tax: fromCents(tax),
      total: fromCents(total),
      shippingAddress: testAddress,
      billingAddress: testAddress,
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
      items: {
        create: {
          productId: 'PRD-1001',
          productName: 'Test Product',
          sku: 'TEST-001',
          quantity: 1,
          unitPrice: fromCents(subtotal),
          total: fromCents(subtotal),
        },
      },
    },
  });
}
