/**
 * Fills a development or test database with sample customers, addresses and
 * orders until a storefront supplies real ones.
 *
 *   DATABASE_URL=postgresql://.../dashboard_db_test npm run seed:dev -- --confirm
 *
 * Safety: it never reads .env (which may point at a shared database), so
 * DATABASE_URL must be set explicitly; it refuses NODE_ENV=production; it does
 * nothing without --confirm; and it refuses a database that already has
 * customers unless --reset is given, which first empties the customer and order
 * tables. The data is the same on every run.
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  PrismaClient,
  type AddressType,
  type OrderStatus,
  type PaymentStatus,
  type Prisma,
} from '../generated/prisma/client';

const CUSTOMER_COUNT = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

const FIRST_NAMES = [
  'Ada',
  'Grace',
  'Alan',
  'Katherine',
  'Linus',
  'Margaret',
  'Dennis',
  'Barbara',
  'Ken',
  'Frances',
  'Tim',
  'Radia',
  'Guido',
  'Hedy',
  'Bjarne',
  'Sophie',
  'James',
  'Evelyn',
  'Niklaus',
  'Joan',
];
const LAST_NAMES = [
  'Lovelace',
  'Hopper',
  'Turing',
  'Johnson',
  'Torvalds',
  'Hamilton',
  'Ritchie',
  'Liskov',
  'Thompson',
  'Allen',
  'Berners-Lee',
  'Perlman',
  'van Rossum',
  'Lamarr',
  'Stroustrup',
  'Wilson',
  'Gosling',
  'Boyd',
  'Wirth',
  'Clarke',
];
const PLACES = [
  {
    city: 'Austin',
    region: 'TX',
    postalCode: '78701',
    country: 'United States',
  },
  {
    city: 'Portland',
    region: 'OR',
    postalCode: '97205',
    country: 'United States',
  },
  { city: 'Toronto', region: 'ON', postalCode: 'M5V 2T6', country: 'Canada' },
  {
    city: 'London',
    region: null,
    postalCode: 'EC1A 1BB',
    country: 'United Kingdom',
  },
  { city: 'Berlin', region: null, postalCode: '10115', country: 'Germany' },
  { city: 'Osaka', region: 'Osaka', postalCode: '530-0001', country: 'Japan' },
  { city: 'Dublin', region: null, postalCode: null, country: 'Ireland' },
];
const PRODUCTS = [
  {
    productId: 'PRD-1001',
    productName: 'Ceramic Mug',
    sku: 'MUG-001',
    unitCents: 1450,
  },
  {
    productId: 'PRD-1002',
    productName: 'Linen Apron',
    sku: 'APR-002',
    unitCents: 3200,
  },
  {
    productId: 'PRD-1003',
    productName: 'Walnut Cutting Board',
    sku: 'BRD-003',
    unitCents: 5875,
  },
  {
    productId: 'PRD-1004',
    productName: 'Pour-over Kettle',
    sku: 'KTL-004',
    unitCents: 8900,
  },
  {
    productId: 'PRD-1005',
    productName: 'Tea Sampler',
    sku: 'TEA-005',
    unitCents: 2405,
  },
  {
    productId: 'PRD-1006',
    productName: 'Cast Iron Skillet',
    sku: 'SKL-006',
    unitCents: 6499,
  },
];
const STATUSES: OrderStatus[] = [
  'DELIVERED',
  'DELIVERED',
  'DELIVERED',
  'SHIPPED',
  'PROCESSING',
  'PENDING',
  'CANCELLED',
];

/** Small deterministic PRNG (mulberry32) so every run produces the same data. */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const money = (cents: number) => (cents / 100).toFixed(2);

function buildData(now: Date) {
  const rand = random(20261009);
  const int = (min: number, max: number) =>
    min + Math.floor(rand() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)];

  const customers: Prisma.CustomerCreateManyInput[] = [];
  const addresses: Prisma.CustomerAddressCreateManyInput[] = [];
  const orders: Prisma.OrderCreateManyInput[] = [];
  const items: Prisma.OrderItemCreateManyInput[] = [];

  for (let i = 0; i < CUSTOMER_COUNT; i++) {
    const first = FIRST_NAMES[i % FIRST_NAMES.length];
    // Shift the surname each time the first names repeat, so no two names match.
    const last =
      LAST_NAMES[
        (i * 7 + Math.floor(i / FIRST_NAMES.length)) % LAST_NAMES.length
      ];
    const name = `${first} ${last}`;
    const email = `${first}.${last}.${i + 1}`
      .toLowerCase()
      .replace(/[^a-z0-9.]/g, '')
      .concat('@example.com');
    const phone = i % 4 === 3 ? null : `+1 555 01${String(i).padStart(2, '0')}`;
    const joinedAt = new Date(now.getTime() - int(30, 730) * DAY_MS);
    const customerId = randomUUID();
    customers.push({ id: customerId, name, email, phone, createdAt: joinedAt });

    // The last customer has nothing yet: no addresses and no orders.
    if (i === CUSTOMER_COUNT - 1) continue;

    const place = pick(PLACES);
    const addressOf = (type: AddressType, isDefault: boolean) => ({
      id: randomUUID(),
      customerId,
      type,
      isDefault,
      recipientName: name,
      phone,
      addressLine1: `${int(1, 999)} ${pick(['Oak', 'Elm', 'Market', 'Station', 'Harbor'])} Street`,
      addressLine2: rand() < 0.3 ? `Apt ${int(1, 40)}` : null,
      ...place,
      createdAt: joinedAt,
    });
    if (i % 5 !== 4) {
      addresses.push(addressOf('SHIPPING', true));
      if (i % 3 === 0) addresses.push(addressOf('SHIPPING', false));
      if (i % 2 === 0) addresses.push(addressOf('BILLING', true));
    }

    const orderCount = i % 6 === 5 ? 0 : int(1, 8);
    const shippingAddress = { ...addressOf('SHIPPING', false) };
    const snapshot: Prisma.InputJsonObject = {
      recipientName: shippingAddress.recipientName,
      phone: shippingAddress.phone,
      addressLine1: shippingAddress.addressLine1,
      addressLine2: shippingAddress.addressLine2,
      city: shippingAddress.city,
      region: shippingAddress.region,
      postalCode: shippingAddress.postalCode,
      country: shippingAddress.country,
    };
    for (let o = 0; o < orderCount; o++) {
      const orderId = randomUUID();
      const sinceJoined = now.getTime() - joinedAt.getTime();
      const createdAt = new Date(joinedAt.getTime() + rand() * sinceJoined);

      let subtotal = 0;
      const lineCount = int(1, 3);
      for (let l = 0; l < lineCount; l++) {
        const product = pick(PRODUCTS);
        const quantity = int(1, 3);
        const lineTotal = quantity * product.unitCents;
        subtotal += lineTotal;
        items.push({
          id: randomUUID(),
          orderId,
          productId: product.productId,
          productName: product.productName,
          sku: product.sku,
          quantity,
          unitPrice: money(product.unitCents),
          total: money(lineTotal),
        });
      }
      const shipping = subtotal >= 10000 ? 0 : 799;
      const discount = rand() < 0.2 ? Math.round(subtotal * 0.1) : 0;
      const tax = Math.round((subtotal - discount) * 0.08);
      const status = pick(STATUSES);
      const paymentStatus: PaymentStatus =
        status === 'CANCELLED'
          ? rand() < 0.5
            ? 'REFUNDED'
            : 'PENDING'
          : status === 'PENDING'
            ? 'PENDING'
            : 'PAID';

      orders.push({
        id: orderId,
        customerId,
        customerName: name,
        customerEmail: email,
        customerPhone: phone,
        status,
        paymentStatus,
        subtotal: money(subtotal),
        shipping: money(shipping),
        discount: money(discount),
        tax: money(tax),
        total: money(subtotal + shipping - discount + tax),
        shippingAddress: snapshot,
        billingAddress: snapshot,
        createdAt,
      });
    }
  }

  // Insert in date order so CUS- and ORD- numbers rise with time.
  const byDate = (a: { createdAt?: unknown }, b: { createdAt?: unknown }) =>
    (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime();
  customers.sort(byDate);
  orders.sort(byDate);
  return { customers, addresses, orders, items };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      confirm: { type: 'boolean', default: false },
      reset: { type: 'boolean', default: false },
    },
  });

  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed: NODE_ENV is production.');
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'Set DATABASE_URL explicitly for the database to seed. This script does not read .env.',
    );
  }
  const target = new URL(url);
  const databaseName = target.pathname.slice(1);
  console.log(`Target database: "${databaseName}" on ${target.hostname}`);
  if (!values.confirm) {
    throw new Error(
      'Nothing done. Re-run with --confirm to seed this database.',
    );
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  try {
    if (values.reset) {
      await prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "OrderItem", "Order", "CustomerAddress", "Customer"',
      );
    } else if ((await prisma.customer.count()) > 0) {
      throw new Error(
        'The database already has customers. Re-run with --reset to replace them.',
      );
    }

    const data = buildData(new Date());
    await prisma.$transaction([
      prisma.customer.createMany({ data: data.customers }),
      prisma.customerAddress.createMany({ data: data.addresses }),
      prisma.order.createMany({ data: data.orders }),
      prisma.orderItem.createMany({ data: data.items }),
    ]);
    console.log(
      `Seeded ${data.customers.length} customers, ${data.addresses.length} addresses, ${data.orders.length} orders and ${data.items.length} order lines.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
