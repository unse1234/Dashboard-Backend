import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import {
  MAIL_TRANSPORT,
  type MailMessage,
  type MailSendResult,
  type MailTransport,
} from '../src/mail/mail-transport';
import type {
  AddressType,
  Currency,
  OrderConfirmationStatus,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  ProductStatus,
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
  /** Every attempt, failed ones included, in order. */
  readonly attempted: MailMessage[] = [];
  private readonly failures: unknown[] = [];
  /** Wait before each send, so that concurrent dispatches really overlap. */
  delayMs = 0;

  async send(message: MailMessage): Promise<MailSendResult> {
    this.attempted.push(message);
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    if (this.failures.length > 0) throw this.failures.shift();
    this.sent.push(message);
    return { messageId: `<memory-${this.sent.length}@test>` };
  }

  /** The next `times` sends throw `error` instead of sending. */
  failNext(error: unknown, times = 1): void {
    for (let i = 0; i < times; i++) this.failures.push(error);
  }

  to(email: string): MailMessage[] {
    return this.sent.filter((m) => m.to === email);
  }

  clear(): void {
    this.sent.length = 0;
    this.attempted.length = 0;
    this.failures.length = 0;
    this.delayMs = 0;
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
    // "Category" is reference data the migration seeds, so it is left alone.
    'TRUNCATE TABLE "Session", "PasswordResetToken", "EmailVerificationToken", "ImportJob", "User", "ProductEvent", "OrderEvent", "OrderItem", "EmailJob", "StorefrontToken", "Order", "Product", "CustomerAddress", "Customer", "StorefrontSession", "StorefrontAccount" CASCADE',
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

/** The product fields an order line is built from. */
export interface LineProduct {
  id: string;
  number: number;
  name: string;
  sku: string;
  price: { toString(): string };
}

export interface OrderOptions {
  /** The order total (default 100). The subtotal is derived from it. */
  total?: number;
  shipping?: number;
  discount?: number;
  tax?: number;
  status?: OrderStatus;
  /** Defaults to one that goes with `status`: paid, unpaid, or refunded when cancelled. */
  paymentStatus?: PaymentStatus;
  /** Null (the default) is a legacy order, without a payment method. */
  paymentMethod?: PaymentMethod | null;
  /** Defaults to PKR; pass USD explicitly for historical fixtures. */
  currency?: Currency;
  createdAt?: Date;
  /** Fields to change in the delivery address the order records. */
  shippingAddress?: Partial<TestAddress>;
  /**
   * Lines of real products, snapshotted at their current price. Replaces the
   * single placeholder line, and `total` is then derived from the lines instead.
   * This only records the order: it does not touch the products' stock.
   */
  items?: { product: LineProduct; quantity: number }[];
  /** Email-confirmation fields. Left out, the order is EXEMPT, as every order before them. */
  confirmation?: {
    status: OrderConfirmationStatus;
    email?: string | null;
    expiresAt?: Date | null;
    confirmedAt?: Date | null;
    storefrontAccountId?: string | null;
  };
}

// A type alias, not an interface: only an alias is assignable to Prisma's JSON
// input, which wants an index signature.
type TestAddress = {
  recipientName: string;
  phone: string | null;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  region: string | null;
  postalCode: string | null;
  country: string;
};

const testAddress: TestAddress = {
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
 * Creates an order whose amounts satisfy the database checks. By default it has
 * one placeholder line and subtotal = total - shipping + discount - tax; with
 * `items` the lines come first and the total follows from them.
 */
export function createOrder(
  prisma: PrismaService,
  customer: { id: string; name: string; email: string; phone: string | null },
  options: OrderOptions = {},
) {
  const shipping = toCents(options.shipping ?? 0);
  const discount = toCents(options.discount ?? 0);
  const tax = toCents(options.tax ?? 0);

  const lines = options.items?.map(({ product, quantity }) => ({
    productId: `PRD-${product.number}`,
    productName: product.name,
    sku: product.sku,
    quantity,
    unitCents: toCents(Number(product.price.toString())),
    catalogProductId: product.id,
  }));

  const subtotal = lines
    ? lines.reduce((sum, line) => sum + line.unitCents * line.quantity, 0)
    : toCents(options.total ?? 100) - shipping + discount - tax;
  const total = subtotal + shipping - discount + tax;

  const itemLines = lines
    ? lines.map(({ unitCents, ...line }, position) => ({
        ...line,
        unitPrice: fromCents(unitCents),
        total: fromCents(unitCents * line.quantity),
        position,
      }))
    : [
        {
          productId: 'PRD-1001',
          productName: 'Test Product',
          sku: 'TEST-001',
          quantity: 1,
          unitPrice: fromCents(subtotal),
          total: fromCents(subtotal),
          position: 0,
        },
      ];
  const status = options.status ?? 'DELIVERED';
  // A payment status that goes with the status, as the database requires.
  const paymentStatus =
    options.paymentStatus ??
    (status === 'CANCELLED'
      ? 'REFUNDED'
      : status === 'PENDING'
        ? 'PENDING'
        : 'PAID');

  return prisma.order.create({
    data: {
      customerId: customer.id,
      customerName: customer.name,
      customerEmail: customer.email,
      customerPhone: customer.phone,
      status,
      paymentStatus,
      ...(options.paymentMethod !== undefined
        ? { paymentMethod: options.paymentMethod }
        : {}),
      ...(options.currency ? { currency: options.currency } : {}),
      itemCount: itemLines.reduce((units, line) => units + line.quantity, 0),
      subtotal: fromCents(subtotal),
      shipping: fromCents(shipping),
      discount: fromCents(discount),
      tax: fromCents(tax),
      total: fromCents(total),
      shippingAddress: { ...testAddress, ...options.shippingAddress },
      billingAddress: testAddress,
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
      ...(options.confirmation
        ? {
            confirmationStatus: options.confirmation.status,
            confirmationEmail: options.confirmation.email,
            confirmationExpiresAt: options.confirmation.expiresAt,
            confirmedAt: options.confirmation.confirmedAt,
            storefrontAccountId: options.confirmation.storefrontAccountId,
          }
        : {}),
      items: { create: itemLines },
    },
  });
}

export interface ProductOptions {
  name?: string;
  sku?: string;
  description?: string | null;
  brand?: string | null;
  /** The name of one of the seeded categories (default "Electronics"). */
  category?: string;
  status?: ProductStatus;
  price?: number | string;
  /** Defaults to PKR; pass USD explicitly for historical fixtures. */
  currency?: Currency;
  costPrice?: number | string | null;
  stock?: number;
  archived?: boolean;
  subtitle?: string | null;
  imageUrl?: string | null;
  galleryUrls?: string[];
  createdAt?: Date;
}

/** One of the categories the migration seeds. */
export function getCategory(prisma: PrismaService, name = 'Electronics') {
  return prisma.category.findUniqueOrThrow({ where: { name } });
}

let productSeq = 0;

export async function createProduct(
  prisma: PrismaService,
  options: ProductOptions = {},
) {
  productSeq += 1;
  const category = await getCategory(prisma, options.category);
  return prisma.product.create({
    data: {
      name: options.name ?? `Product ${productSeq}`,
      sku: options.sku ?? `SKU-${productSeq}`,
      description: options.description ?? null,
      brand: options.brand ?? null,
      categoryId: category.id,
      status: options.status ?? 'ACTIVE',
      price: options.price ?? '10.00',
      ...(options.currency ? { currency: options.currency } : {}),
      costPrice: options.costPrice ?? null,
      stock: options.stock ?? 10,
      archivedAt: options.archived ? new Date() : null,
      subtitle: options.subtitle ?? null,
      imageUrl: options.imageUrl ?? null,
      ...(options.galleryUrls ? { galleryUrls: options.galleryUrls } : {}),
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    },
  });
}
