/**
 * Fills a development or test database with a sample catalogue, customers,
 * addresses and orders until a storefront supplies real ones. Order lines refer
 * to catalogue products and snapshot their name, SKU and price.
 *
 *   DATABASE_URL=postgresql://.../dashboard_db_test npm run seed:dev -- --confirm
 *
 * Safety: it never reads .env (which may point at a shared database), so
 * DATABASE_URL must be set explicitly; it refuses NODE_ENV=production; it does
 * nothing without --confirm; and it refuses a database that already has
 * customers or products unless --reset is given, which first empties the
 * product, customer and order tables (categories are reference data and stay).
 * The data is the same on every run.
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
  type ProductStatus,
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

interface CatalogueEntry {
  name: string;
  sku: string;
  brand: string | null;
  /** One of the categories the migration seeds. */
  category: string;
  priceCents: number;
  /** Null when the cost is unknown. */
  costCents: number | null;
  stock: number;
  status?: ProductStatus;
  /** Hidden from the dashboard; no new order may include it. */
  archived?: boolean;
}

// Spread across the seeded categories, with a few inactive, out-of-stock and
// archived products so that every state of the lists is represented.
const CATALOGUE: CatalogueEntry[] = [
  {
    name: 'Aurora Wireless Noise-Cancelling Headphones',
    sku: 'AUD-ANC-500-BLK',
    brand: 'Soundcraft',
    category: 'Electronics',
    priceCents: 24900,
    costCents: 13850,
    stock: 184,
  },
  {
    name: 'Compact Mechanical Keyboard',
    sku: 'KBD-MECH-65',
    brand: 'Keyline',
    category: 'Electronics',
    priceCents: 8950,
    costCents: 4120,
    stock: 76,
  },
  {
    name: '27-inch 4K Monitor',
    sku: 'MON-4K-27',
    brand: 'Visora',
    category: 'Electronics',
    priceCents: 42900,
    costCents: 29800,
    stock: 23,
  },
  {
    name: 'USB-C Docking Station',
    sku: 'DOC-USBC-11',
    brand: 'Keyline',
    category: 'Electronics',
    priceCents: 13900,
    costCents: null,
    stock: 0,
  },
  {
    name: 'Wireless Ergonomic Mouse',
    sku: 'MSE-ERGO-W',
    brand: 'Keyline',
    category: 'Electronics',
    priceCents: 4995,
    costCents: 1890,
    stock: 310,
  },
  {
    name: 'Portable SSD 1 TB',
    sku: 'SSD-PORT-1TB',
    brand: null,
    category: 'Electronics',
    priceCents: 10900,
    costCents: 7450,
    stock: 58,
    status: 'INACTIVE',
  },
  {
    name: 'Pre-Seasoned Cast Iron Skillet, 12 inch',
    sku: 'HK-CIS-12',
    brand: 'Hearthstone',
    category: 'Home & Kitchen',
    priceCents: 3995,
    costCents: 1720,
    stock: 62,
  },
  {
    name: 'Ceramic Pour-over Set',
    sku: 'HK-POUR-SET',
    brand: 'Hearthstone',
    category: 'Home & Kitchen',
    priceCents: 3400,
    costCents: 1500,
    stock: 140,
  },
  {
    name: 'Linen Apron',
    sku: 'HK-APR-LIN',
    brand: null,
    category: 'Home & Kitchen',
    priceCents: 3200,
    costCents: 1100,
    stock: 95,
  },
  {
    name: 'Walnut Cutting Board',
    sku: 'HK-BRD-WLN',
    brand: 'Oakmoor',
    category: 'Home & Kitchen',
    priceCents: 5875,
    costCents: 2600,
    stock: 41,
  },
  {
    name: 'Stainless Steel Gooseneck Kettle',
    sku: 'HK-KTL-GSN',
    brand: 'Hearthstone',
    category: 'Home & Kitchen',
    priceCents: 8900,
    costCents: 4300,
    stock: 18,
  },
  {
    name: 'Tea Sampler',
    sku: 'HK-TEA-SMP',
    brand: null,
    category: 'Home & Kitchen',
    priceCents: 2405,
    costCents: 980,
    stock: 0,
  },
  {
    name: 'Ergonomic Mesh Office Chair with Adjustable Lumbar Support and Headrest',
    sku: 'FUR-CHR-MESH-02',
    brand: 'Northwind',
    category: 'Furniture',
    priceCents: 32900,
    costCents: 18800,
    stock: 9,
  },
  {
    name: 'Walnut Standing Desk, 160 × 80 cm',
    sku: 'FUR-DSK-WLN-160',
    brand: 'Oakmoor',
    category: 'Furniture',
    priceCents: 89900,
    costCents: 51200,
    stock: 14,
    status: 'INACTIVE',
  },
  {
    name: 'Oak Bookshelf, 5 Shelves',
    sku: 'FUR-BKS-OAK-5',
    brand: 'Oakmoor',
    category: 'Furniture',
    priceCents: 21900,
    costCents: 12400,
    stock: 27,
  },
  {
    name: 'Brass Floor Lamp',
    sku: 'FUR-LMP-BRS',
    brand: 'Northwind',
    category: 'Furniture',
    priceCents: 12000,
    costCents: null,
    stock: 33,
  },
  {
    name: 'Storage Ottoman',
    sku: 'FUR-OTT-STO',
    brand: null,
    category: 'Furniture',
    priceCents: 14900,
    costCents: 7600,
    stock: 12,
  },
  {
    name: 'Hardcover Notebook, 3-pack',
    sku: 'OFF-NTB-HC3',
    brand: 'Paperline',
    category: 'Office Supplies',
    priceCents: 1850,
    costCents: 620,
    stock: 520,
  },
  {
    name: 'Fountain Pen Set',
    sku: 'OFF-PEN-FNT',
    brand: 'Paperline',
    category: 'Office Supplies',
    priceCents: 4500,
    costCents: 1750,
    stock: 64,
  },
  {
    name: 'Desk Organizer',
    sku: 'OFF-ORG-DSK',
    brand: null,
    category: 'Office Supplies',
    priceCents: 2790,
    costCents: 1150,
    stock: 88,
  },
  {
    name: 'Whiteboard, 90 × 60 cm',
    sku: 'OFF-WBD-9060',
    brand: 'Paperline',
    category: 'Office Supplies',
    priceCents: 6400,
    costCents: 3100,
    stock: 0,
  },
  {
    name: 'Sticky Notes, Bulk Pack',
    sku: 'OFF-STK-BLK',
    brand: 'Paperline',
    category: 'Office Supplies',
    priceCents: 1200,
    costCents: 380,
    stock: 1450,
  },
  {
    name: 'Trail Insulated Water Bottle, 750 ml',
    sku: 'SPT-BTL-750-GRN',
    brand: 'Ridgeline',
    category: 'Sports & Outdoors',
    priceCents: 2450,
    costCents: 980,
    stock: 1240,
  },
  {
    name: 'Trail Running Backpack, 20 L',
    sku: 'SPT-BPK-20',
    brand: 'Ridgeline',
    category: 'Sports & Outdoors',
    priceCents: 7900,
    costCents: 3600,
    stock: 47,
  },
  {
    name: 'Cork Yoga Mat',
    sku: 'SPT-YGA-CRK',
    brand: null,
    category: 'Sports & Outdoors',
    priceCents: 3500,
    costCents: 1400,
    stock: 105,
  },
  {
    name: 'Rechargeable Camping Lantern',
    sku: 'SPT-LNT-RCH',
    brand: 'Ridgeline',
    category: 'Sports & Outdoors',
    priceCents: 2999,
    costCents: 1300,
    stock: 72,
  },
  {
    name: 'Resistance Band Set',
    sku: 'SPT-RSB-SET',
    brand: null,
    category: 'Sports & Outdoors',
    priceCents: 1999,
    costCents: 700,
    stock: 260,
    status: 'INACTIVE',
  },
  {
    name: 'Leather Card Holder',
    sku: 'ACC-CRD-LTH',
    brand: 'Northwind',
    category: 'Accessories',
    priceCents: 3800,
    costCents: 1500,
    stock: 120,
  },
  {
    name: 'Canvas Tote Bag',
    sku: 'ACC-TOT-CNV',
    brand: null,
    category: 'Accessories',
    priceCents: 2200,
    costCents: 750,
    stock: 340,
  },
  {
    name: 'Adjustable Phone Stand',
    sku: 'ACC-PHN-STD',
    brand: 'Keyline',
    category: 'Accessories',
    priceCents: 1500,
    costCents: 520,
    stock: 410,
  },
  {
    name: 'Desk Clock, Discontinued',
    sku: 'ACC-CLK-OLD',
    brand: null,
    category: 'Accessories',
    priceCents: 1900,
    costCents: 800,
    stock: 5,
    archived: true,
  },
];

/** A catalogue product as the orders need it once it has been inserted. */
interface SeededProduct {
  id: string;
  number: number;
  name: string;
  sku: string;
  priceCents: number;
}

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
const dollars = (cents: number) => cents / 100;

/**
 * Catalogue rows and their history. The first entries are the oldest, so PRD-
 * numbers rise with creation time. Nothing here has an author: automatic
 * history reads "System" in the dashboard.
 */
function buildCatalogue(now: Date, categoryIds: Map<string, string>) {
  const products: Prisma.ProductCreateManyInput[] = [];
  const events: Prisma.ProductEventCreateManyInput[] = [];

  CATALOGUE.forEach((entry, index) => {
    const categoryId = categoryIds.get(entry.category);
    if (!categoryId) {
      throw new Error(
        `Category "${entry.category}" does not exist. Apply the migrations first.`,
      );
    }
    const id = randomUUID();
    const createdAt = new Date(
      now.getTime() - (CATALOGUE.length - index) * 21 * DAY_MS,
    );
    products.push({
      id,
      name: entry.name,
      sku: entry.sku,
      brand: entry.brand,
      categoryId,
      status: entry.status ?? 'ACTIVE',
      price: money(entry.priceCents),
      costPrice: entry.costCents === null ? null : money(entry.costCents),
      stock: entry.stock,
      archivedAt: entry.archived ? new Date(now.getTime() - 5 * DAY_MS) : null,
      createdAt,
    });

    const later = (days: number) =>
      new Date(createdAt.getTime() + days * DAY_MS);
    events.push({
      productId: id,
      type: 'CREATED',
      data: {},
      createdAt,
    });
    if (index % 4 === 0) {
      events.push({
        productId: id,
        type: 'PRICE_CHANGED',
        data: {
          field: 'price',
          from: dollars(Math.round(entry.priceCents * 1.08)),
          to: dollars(entry.priceCents),
        },
        createdAt: later(30),
      });
    }
    if (index % 3 === 0) {
      events.push({
        productId: id,
        type: 'STOCK_CHANGED',
        data: {
          from: Math.max(entry.stock - 24, 0),
          to: entry.stock,
          reason: 'MANUAL',
        },
        createdAt: later(45),
      });
    }
    if (entry.archived) {
      events.push({
        productId: id,
        type: 'ARCHIVED',
        data: {},
        createdAt: new Date(now.getTime() - 5 * DAY_MS),
      });
    }
  });

  return { products, events };
}

function buildData(now: Date, orderable: SeededProduct[]) {
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
      let itemCount = 0;
      const lineCount = int(1, 3);
      for (let l = 0; l < lineCount; l++) {
        const product = pick(orderable);
        const quantity = int(1, 3);
        const lineTotal = quantity * product.priceCents;
        subtotal += lineTotal;
        itemCount += quantity;
        items.push({
          id: randomUUID(),
          orderId,
          position: l,
          productId: `PRD-${product.number}`,
          productName: product.name,
          sku: product.sku,
          quantity,
          unitPrice: money(product.priceCents),
          total: money(lineTotal),
          catalogProductId: product.id,
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
        itemCount,
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
        'TRUNCATE TABLE "ProductEvent", "OrderEvent", "OrderItem", "Order", "CustomerAddress", "Customer", "Product"',
      );
    } else if (
      (await prisma.customer.count()) > 0 ||
      (await prisma.product.count()) > 0
    ) {
      throw new Error(
        'The database already has customers or products. Re-run with --reset to replace them.',
      );
    }

    const categories = await prisma.category.findMany({
      select: { id: true, name: true },
    });
    const now = new Date();
    const catalogue = buildCatalogue(
      now,
      new Map(categories.map(({ id, name }) => [name, id])),
    );

    const counts = await prisma.$transaction(async (tx) => {
      // The products come first: orders snapshot their numbers and prices.
      const inserted = await tx.product.createManyAndReturn({
        data: catalogue.products,
        select: { id: true, number: true, sku: true },
      });
      await tx.productEvent.createMany({ data: catalogue.events });

      const bySku = new Map(CATALOGUE.map((entry) => [entry.sku, entry]));
      const orderable: SeededProduct[] = [];
      for (const { id, number, sku } of inserted) {
        const entry = bySku.get(sku);
        if (!entry) throw new Error(`Unexpected product ${sku}`);
        if (entry.archived || (entry.status ?? 'ACTIVE') !== 'ACTIVE') continue;
        orderable.push({
          id,
          number,
          name: entry.name,
          sku,
          priceCents: entry.priceCents,
        });
      }

      const data = buildData(now, orderable);
      await tx.customer.createMany({ data: data.customers });
      await tx.customerAddress.createMany({ data: data.addresses });
      await tx.order.createMany({ data: data.orders });
      await tx.orderItem.createMany({ data: data.items });
      return {
        products: inserted.length,
        customers: data.customers.length,
        addresses: data.addresses.length,
        orders: data.orders.length,
        lines: data.items.length,
      };
    });
    console.log(
      `Seeded ${counts.products} products, ${counts.customers} customers, ${counts.addresses} addresses, ${counts.orders} orders and ${counts.lines} order lines.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
