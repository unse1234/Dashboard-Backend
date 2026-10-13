import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { IMPORT_LOCK_NAMESPACE } from '../src/imports/import.constants';
import { ImportsService } from '../src/imports/imports.service';
import {
  bearer,
  createTestApp,
  createUser,
  getCategory,
  login,
  resetDatabase,
  type TestContext,
} from './helpers';

jest.setTimeout(30_000);

describe('Product imports (e2e)', () => {
  let ctx: TestContext;
  let admin: string;
  let staff: string;
  const http = () => request(ctx.app.getHttpServer());
  const csv = (rows: string[]) =>
    Buffer.from(
      [
        'name,sku,category,price,costPrice,stock,status,brand,description',
        ...rows,
      ].join('\n'),
    );
  const upload = (body: Buffer, token = admin, key = randomUUID()) =>
    http()
      .post('/imports/preview')
      .set(bearer(token))
      .field('type', 'PRODUCTS')
      .field('clientRequestId', key)
      .attach('file', body, {
        filename: 'products.csv',
        contentType: 'text/csv',
      });

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    await createUser(ctx.prisma, {
      email: 'imports-admin@example.com',
      role: 'ADMIN',
    });
    await createUser(ctx.prisma, {
      email: 'imports-staff@example.com',
      role: 'STAFF',
    });
    admin = (await login(ctx.app, 'imports-admin@example.com')).accessToken;
    staff = (await login(ctx.app, 'imports-staff@example.com')).accessToken;
  });
  // The migration's categories are reference data; imports add more, so drop
  // the ones these tests made (their products are gone by then).
  const NEW_CATEGORY_PREFIX = 'E2E Import ';
  const removeImportedCategories = () =>
    ctx.prisma.category.deleteMany({
      where: { name: { startsWith: NEW_CATEGORY_PREFIX } },
    });
  afterAll(async () => {
    await resetDatabase(ctx.prisma);
    await removeImportedCategories();
    await ctx.close();
  });
  beforeEach(async () => {
    await ctx.prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ImportJob", "ProductEvent", "Product" CASCADE',
    );
    await removeImportedCategories();
  });

  it('exposes only a header-only CSV template and requires authentication', async () => {
    await http().get('/imports/types').expect(401);
    const types = await http()
      .get('/imports/types')
      .set(bearer(staff))
      .expect(200);
    expect(types.body.data[0]).toMatchObject({
      type: 'PRODUCTS',
      extensions: ['.csv'],
    });
    const template = await http()
      .get('/imports/templates/products')
      .set(bearer(staff))
      .expect(200);
    expect(template.headers['content-disposition']).toContain(
      'products-import-v1.csv',
    );
    expect(template.text).toContain('name,sku,category,price');
    expect(template.text.trim().split('\n')).toHaveLength(1);
  });

  it('previews without writes, then confirms every product and event atomically', async () => {
    const category = await getCategory(ctx.prisma);
    const body = csv([
      `Blue Mug,IMP-1,${category.name},12.50,4.00,5,ACTIVE,Acme,Blue mug`,
      `Red Mug,IMP-2,${category.name},14.00,,0,INACTIVE,,`,
    ]);
    const key = randomUUID();
    const preview = await upload(body, admin, key).expect(201);
    expect(preview.body.job).toMatchObject({
      status: 'READY',
      totalRows: 2,
      validRows: 2,
    });
    expect(await ctx.prisma.product.count()).toBe(0);
    // A lost response is replayed with 200, never created twice.
    const replay = await upload(body, admin, key).expect(200);
    expect(replay.body.job.id).toBe(preview.body.job.id);
    const id = preview.body.job.id as string;
    const result = await http()
      .post(`/imports/${id}/confirm`)
      .set(bearer(admin))
      .send({
        schemaVersion: 1,
        previewHash: preview.body.job.previewHash,
      })
      .expect(200);
    expect(result.body.job).toMatchObject({
      status: 'COMPLETED',
      importedRows: 2,
    });
    expect(await ctx.prisma.product.count()).toBe(2);
    expect(
      await ctx.prisma.productEvent.count({ where: { type: 'CREATED' } }),
    ).toBe(2);
    await http()
      .post(`/imports/${id}/confirm`)
      .set(bearer(admin))
      .send({
        schemaVersion: 1,
        previewHash: preview.body.job.previewHash,
      })
      .expect(200);
    expect(await ctx.prisma.product.count()).toBe(2);
    await http().get(`/imports/${id}/preview`).set(bearer(admin)).expect(410);
  });

  it('blocks every write when any row is invalid and offers a safe report', async () => {
    const category = await getCategory(ctx.prisma);
    const preview = await upload(
      csv([
        `Valid Item,IMP-GOOD,${category.name},12.50,,,,,`,
        `Bad Item,IMP-BAD,${category.name},not-a-price,,,,,`,
      ]),
    ).expect(201);
    expect(preview.body.job).toMatchObject({
      status: 'VALIDATION_FAILED',
      invalidRows: 1,
    });
    const id = preview.body.job.id as string;
    const stored = await ctx.prisma.importJob.findFirstOrThrow({
      where: { number: Number(id.slice(4)) },
    });
    await http()
      .post(`/imports/${id}/confirm`)
      .set(bearer(admin))
      .send({
        schemaVersion: 1,
        previewHash: stored.previewHash,
      })
      .expect(409);
    expect(await ctx.prisma.product.count()).toBe(0);
    const report = await http()
      .get(`/imports/${id}/errors?format=csv`)
      .set(bearer(admin))
      .expect(200);
    expect(report.text).toContain('INVALID_MONEY');
    expect(report.text).not.toContain('IMP-BAD');
  });

  it('creates a category the catalogue does not have, once, and reuses it', async () => {
    const name = `${NEW_CATEGORY_PREFIX}Garden`;
    const before = await ctx.prisma.category.count();
    const preview = await upload(
      csv([
        `Spade,IMP-NEW-1,${name},20,,,,,`,
        `Rake,IMP-NEW-2,${name.toLowerCase()},15,,,,,`,
      ]),
    ).expect(201);
    expect(preview.body.job).toMatchObject({ status: 'READY', validRows: 2 });
    // Validating creates nothing.
    expect(await ctx.prisma.category.count()).toBe(before);

    await http()
      .post(`/imports/${preview.body.job.id}/confirm`)
      .set(bearer(admin))
      .send({ schemaVersion: 1, previewHash: preview.body.job.previewHash })
      .expect(200);

    expect(await ctx.prisma.category.count()).toBe(before + 1);
    const created = await ctx.prisma.category.findUniqueOrThrow({
      where: { name },
    });
    expect(
      await ctx.prisma.product.count({ where: { categoryId: created.id } }),
    ).toBe(2);
  });

  it('conceals another staff member’s job but allows an admin to inspect it', async () => {
    const category = await getCategory(ctx.prisma);
    const preview = await upload(
      csv([`Mug,IMP-STAFF,${category.name},10,,,,,`]),
      staff,
    ).expect(201);
    const id = preview.body.job.id as string;
    await http().get(`/imports/${id}`).set(bearer(staff)).expect(200);
    await http().get(`/imports/${id}`).set(bearer(admin)).expect(200);
    await http()
      .post(`/imports/${id}/confirm`)
      .set(bearer(admin))
      .send({
        schemaVersion: 1,
        previewHash: preview.body.job.previewHash,
      })
      .expect(404);
    await http().get('/imports?scope=all').set(bearer(staff)).expect(403);
  });

  it('rejects duplicate SKUs already in the catalogue or within the CSV', async () => {
    const category = await getCategory(ctx.prisma);
    await ctx.prisma.product.create({
      data: {
        name: 'Existing',
        sku: 'TAKEN',
        categoryId: category.id,
        price: '1',
        stock: 0,
      },
    });
    const preview = await upload(
      csv([
        `One,taken,${category.name},10,,,,,`,
        `Two,SAME,${category.name},10,,,,,`,
        `Three,same,${category.name},10,,,,,`,
      ]),
    ).expect(201);
    const result = preview.body as { errors: { data: { code: string }[] } };
    expect(result.errors.data.map((item) => item.code)).toEqual(
      expect.arrayContaining(['SKU_EXISTS', 'DUPLICATE_SKU_FILE']),
    );
    expect(await ctx.prisma.product.count()).toBe(1);
  });

  it('rolls back confirmation when the catalogue changed after preview', async () => {
    const category = await getCategory(ctx.prisma);
    const preview = await upload(
      csv([
        `Fresh One,IMP-FRESH-1,${category.name},10,,,,,`,
        `Fresh Two,IMP-FRESH-2,${category.name},10,,,,,`,
      ]),
    ).expect(201);
    await ctx.prisma.product.create({
      data: {
        name: 'Other writer',
        sku: 'imp-fresh-2',
        categoryId: category.id,
        price: '10',
        stock: 0,
      },
    });
    const id = preview.body.job.id as string;
    await http()
      .post(`/imports/${id}/confirm`)
      .set(bearer(admin))
      .send({
        schemaVersion: 1,
        previewHash: preview.body.job.previewHash,
      })
      .expect(409);
    expect(await ctx.prisma.product.count()).toBe(1);
    expect(await ctx.prisma.productEvent.count()).toBe(0);
    const detail = await http()
      .get(`/imports/${id}`)
      .set(bearer(admin))
      .expect(200);
    expect(detail.body).toMatchObject({ status: 'FAILED', retryable: false });
  });

  it('does not duplicate products for concurrent confirmations', async () => {
    const category = await getCategory(ctx.prisma);
    const preview = await upload(
      csv([`One Mug,IMP-RACE,${category.name},10,,,,,`]),
    ).expect(201);
    const id = preview.body.job.id as string;
    const body = {
      schemaVersion: 1,
      previewHash: preview.body.job.previewHash,
    };
    const [a, b] = await Promise.all([
      http().post(`/imports/${id}/confirm`).set(bearer(admin)).send(body),
      http().post(`/imports/${id}/confirm`).set(bearer(admin)).send(body),
    ]);
    expect([200, 202]).toContain(a.status);
    expect([200, 202]).toContain(b.status);
    expect(await ctx.prisma.product.count()).toBe(1);
    expect(await ctx.prisma.productEvent.count()).toBe(1);
  });

  describe('confirmation results', () => {
    it('creates products with the imported values and a CREATED event per product', async () => {
      const category = await getCategory(ctx.prisma);
      const preview = await upload(
        csv([
          `Blue Mug,MUG-1,${category.name},12.50,4.25,7,inactive,Acme,"Line one\nLine two"`,
          `Plain,MUG-2,${category.name},3,,,,,`,
        ]),
      ).expect(201);
      const id = preview.body.job.id as string;

      const result = await http()
        .post(`/imports/${id}/confirm`)
        .set(bearer(admin))
        .send({ schemaVersion: 1, previewHash: preview.body.job.previewHash })
        .expect(200);

      const products = await ctx.prisma.product.findMany({
        orderBy: { sku: 'asc' },
        include: { events: true },
      });
      expect(products).toHaveLength(2);
      expect(products[0]).toMatchObject({
        name: 'Blue Mug',
        sku: 'MUG-1',
        status: 'INACTIVE',
        stock: 7,
        brand: 'Acme',
        description: 'Line one\nLine two',
        categoryId: category.id,
      });
      expect(products[0].price.toString()).toBe('12.5');
      expect(products[0].costPrice?.toString()).toBe('4.25');
      expect(products[1]).toMatchObject({
        status: 'ACTIVE',
        stock: 0,
        brand: null,
        description: null,
        costPrice: null,
      });
      const adminUser = await ctx.prisma.user.findFirstOrThrow({
        where: { email: 'imports-admin@example.com' },
      });
      for (const product of products) {
        expect(product.events).toHaveLength(1);
        expect(product.events[0]).toMatchObject({
          type: 'CREATED',
          actorId: adminUser.id,
        });
      }
      expect([...result.body.job.createdProductIds].sort()).toEqual(
        products.map((product) => `PRD-${product.number}`).sort(),
      );
      expect(result.body.job.previewHash).toBeNull();
    });

    it('rejects a wrong hash, a bad hash format and an unknown schema version', async () => {
      const category = await getCategory(ctx.prisma);
      const preview = await upload(
        csv([`Mug,IMP-HASH,${category.name},10,,,,,`]),
      ).expect(201);
      const id = preview.body.job.id as string;
      const confirm = (body: object) =>
        http().post(`/imports/${id}/confirm`).set(bearer(admin)).send(body);

      await confirm({ schemaVersion: 1, previewHash: 'a'.repeat(64) }).expect(
        409,
      );
      await confirm({ schemaVersion: 1, previewHash: 'nope' }).expect(400);
      await confirm({
        schemaVersion: 2,
        previewHash: preview.body.job.previewHash,
      }).expect(400);
      expect(await ctx.prisma.product.count()).toBe(0);
    });

    it('answers 429 and stays confirmable while another import holds the global slot', async () => {
      const category = await getCategory(ctx.prisma);
      const preview = await upload(
        csv([`Mug,IMP-LOCK,${category.name},10,,,,,`]),
      ).expect(201);
      const id = preview.body.job.id as string;
      const body = {
        schemaVersion: 1,
        previewHash: preview.body.job.previewHash,
      };

      // Another session takes the cross-instance import slot for a moment.
      await ctx.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(${IMPORT_LOCK_NAMESPACE}, 0)::text`;
          await http()
            .post(`/imports/${id}/confirm`)
            .set(bearer(admin))
            .send(body)
            .expect(429);
        },
        { timeout: 20_000 },
      );

      expect(await ctx.prisma.product.count()).toBe(0);
      const waiting = await http()
        .get(`/imports/${id}`)
        .set(bearer(admin))
        .expect(200);
      expect(waiting.body.status).toBe('READY');
      await http()
        .post(`/imports/${id}/confirm`)
        .set(bearer(admin))
        .send(body)
        .expect(200);
      expect(await ctx.prisma.product.count()).toBe(1);
    });
  });

  describe('preview requests', () => {
    it('rejects an upload key reused for a different file', async () => {
      const category = await getCategory(ctx.prisma);
      const key = randomUUID();
      await upload(csv([`One,K-1,${category.name},1,,,,,`]), admin, key).expect(
        201,
      );

      await upload(csv([`Two,K-2,${category.name},2,,,,,`]), admin, key).expect(
        409,
      );
      expect(await ctx.prisma.importJob.count()).toBe(1);
    });

    it('requires authentication and well-formed fields', async () => {
      await http()
        .post('/imports/preview')
        .field('type', 'PRODUCTS')
        .field('clientRequestId', randomUUID())
        .attach('file', csv([]), 'products.csv')
        .expect(401);
      await http()
        .post('/imports/preview')
        .set(bearer(admin))
        .field('type', 'PRODUCTS')
        .field('clientRequestId', randomUUID())
        .expect(400);
      await http()
        .post('/imports/preview')
        .set(bearer(admin))
        .field('type', 'PRODUCTS')
        .field('clientRequestId', 'not-a-uuid')
        .attach('file', csv(['x']), 'products.csv')
        .expect(400);
      await http()
        .post('/imports/preview')
        .set(bearer(admin))
        .field('type', 'CUSTOMERS')
        .field('clientRequestId', randomUUID())
        .attach('file', csv(['x']), 'products.csv')
        .expect(400);
    });

    it('rejects extra multipart fields and unexpected file fields', async () => {
      await http()
        .post('/imports/preview')
        .set(bearer(admin))
        .field('type', 'PRODUCTS')
        .field('clientRequestId', randomUUID())
        .field('extra', 'x')
        .attach('file', csv(['x']), 'products.csv')
        .expect(400);
      await http()
        .post('/imports/preview')
        .set(bearer(admin))
        .field('type', 'PRODUCTS')
        .field('clientRequestId', randomUUID())
        .attach('other', csv(['x']), 'products.csv')
        .expect(400);
    });

    it.each([
      [
        'a spreadsheet container renamed to .csv',
        () => Buffer.from('PK\u0003\u0004 not really a csv'),
        'products.csv',
        415,
      ],
      ['a file with another extension', () => csv(['x']), 'products.xlsx', 415],
      [
        'text that is not UTF-8',
        () =>
          Buffer.concat([
            Buffer.from('name,sku,category,price\nMug,S-1,Home,1'),
            Buffer.from([0xff, 0xfe]),
          ]),
        'products.csv',
        415,
      ],
      [
        'a header-only file',
        () => Buffer.from('name,sku,category,price'),
        'products.csv',
        400,
      ],
      [
        'a file missing a required column',
        () => Buffer.from('name,sku,price\nMug,S-1,1'),
        'products.csv',
        400,
      ],
      [
        'a file with a protected column',
        () => Buffer.from('name,sku,category,price,id\nMug,S-1,Home,1,abc'),
        'products.csv',
        400,
      ],
      [
        'a record with the wrong field count',
        () => Buffer.from('name,sku,category,price\nMug,S-1,Home'),
        'products.csv',
        400,
      ],
      [
        'more than 250 records',
        () =>
          Buffer.from(
            [
              'name,sku,category,price',
              ...Array.from({ length: 251 }, (_, i) => `P${i},S-${i},Home,1`),
            ].join('\n'),
          ),
        'products.csv',
        413,
      ],
      [
        'a file over 10 MiB',
        () => Buffer.alloc(10 * 1024 * 1024 + 1, 'a'),
        'products.csv',
        413,
      ],
    ])(
      'rejects %s without creating a job',
      async (_label, body, filename, status) => {
        await http()
          .post('/imports/preview')
          .set(bearer(admin))
          .field('type', 'PRODUCTS')
          .field('clientRequestId', randomUUID())
          .attach('file', body(), { filename, contentType: 'text/csv' })
          .expect(status);

        expect(await ctx.prisma.importJob.count()).toBe(0);
        expect(await ctx.prisma.product.count()).toBe(0);
      },
    );

    it('limits each user to three retained previews and counts only retained ones', async () => {
      const category = await getCategory(ctx.prisma);
      const make = (n: number) =>
        upload(csv([`Mug ${n},Q-${n},${category.name},1,,,,,`]), staff);
      const first = await make(1).expect(201);
      await make(2).expect(201);
      await make(3).expect(201);

      await make(4).expect(429);

      // Completing one frees its slot: its rows are purged.
      await http()
        .post(`/imports/${first.body.job.id as string}/confirm`)
        .set(bearer(staff))
        .send({ schemaVersion: 1, previewHash: first.body.job.previewHash })
        .expect(200);
      await make(4).expect(201);
      // Another user is unaffected.
      await upload(csv([`Other,Q-9,${category.name},1,,,,,`]), admin).expect(
        201,
      );
    });
  });

  describe('history and details', () => {
    it('scopes the list to the caller, with counts that ignore the status filter', async () => {
      const category = await getCategory(ctx.prisma);
      const ok = await upload(
        csv([`Mug,H-1,${category.name},1,,,,,`]),
        staff,
      ).expect(201);
      await upload(
        csv([`Bad,H-2,${category.name},not-a-price,,,,,`]),
        staff,
      ).expect(201);
      await upload(
        csv([`Admin mug,H-3,${category.name},1,,,,,`]),
        admin,
      ).expect(201);
      await http()
        .post(`/imports/${ok.body.job.id as string}/confirm`)
        .set(bearer(staff))
        .send({ schemaVersion: 1, previewHash: ok.body.job.previewHash })
        .expect(200);

      const own = await http().get('/imports').set(bearer(staff)).expect(200);
      expect(own.body.meta).toMatchObject({
        page: 1,
        pageSize: 20,
        total: 2,
        totalPages: 1,
      });
      expect(own.body.meta.statusCounts).toMatchObject({
        COMPLETED: 1,
        VALIDATION_FAILED: 1,
        READY: 0,
      });
      expect(own.body.data[0].initiatedBy).toMatchObject({
        isCurrentUser: true,
      });
      // Newest first.
      const listed = own.body as { data: { status: string }[] };
      expect(listed.data.map((job) => job.status)).toEqual([
        'VALIDATION_FAILED',
        'COMPLETED',
      ]);

      const filtered = await http()
        .get('/imports?status=COMPLETED')
        .set(bearer(staff))
        .expect(200);
      expect(filtered.body.meta.total).toBe(1);
      expect(filtered.body.meta.statusCounts.VALIDATION_FAILED).toBe(1);

      const all = await http()
        .get('/imports?scope=all')
        .set(bearer(admin))
        .expect(200);
      expect(all.body.meta.total).toBe(3);
      const mine = await http().get('/imports').set(bearer(admin)).expect(200);
      expect(mine.body.meta.total).toBe(1);
    });

    it('validates list queries and job ids', async () => {
      await http().get('/imports?pageSize=101').set(bearer(admin)).expect(400);
      await http().get('/imports?page=0').set(bearer(admin)).expect(400);
      await http().get('/imports?status=QUEUED').set(bearer(admin)).expect(400);
      await http().get('/imports?unknown=1').set(bearer(admin)).expect(400);
      await http().get('/imports/not-an-id').set(bearer(admin)).expect(400);
      await http().get('/imports/IMP-999999').set(bearer(admin)).expect(404);
    });

    it('pages the preview and error lists', async () => {
      const category = await getCategory(ctx.prisma);
      const preview = await upload(
        csv([
          `One,P-1,${category.name},1,,,,,`,
          `Two,P-2,${category.name},bad,,,,,`,
          `Three,P-3,${category.name},1,,,,,`,
        ]),
        staff,
      ).expect(201);
      const id = preview.body.job.id as string;

      const page = await http()
        .get(`/imports/${id}/preview?page=2&pageSize=2`)
        .set(bearer(staff))
        .expect(200);
      expect(page.body.meta).toEqual({
        page: 2,
        pageSize: 2,
        total: 3,
        totalPages: 2,
      });
      expect(page.body.data).toHaveLength(1);
      expect(page.body.data[0].rowNumber).toBe(4);

      const errors = await http()
        .get(`/imports/${id}/errors`)
        .set(bearer(staff))
        .expect(200);
      expect(errors.body.data).toEqual([
        {
          rowNumber: 3,
          field: 'price',
          code: 'INVALID_MONEY',
          message: expect.any(String),
        },
      ]);

      await http()
        .get(`/imports/${id}/preview?pageSize=51`)
        .set(bearer(staff))
        .expect(400);
      // An admin may read any job.
      await http().get(`/imports/${id}/preview`).set(bearer(admin)).expect(200);
    });

    it('hides a job from a different staff member', async () => {
      const category = await getCategory(ctx.prisma);
      await createUser(ctx.prisma, {
        email: 'imports-staff-2@example.com',
        role: 'STAFF',
        name: 'Second Staff',
      });
      const second = (await login(ctx.app, 'imports-staff-2@example.com'))
        .accessToken;
      const preview = await upload(
        csv([`Mug,S-HIDE,${category.name},1,,,,,`]),
        staff,
      ).expect(201);
      const id = preview.body.job.id as string;

      for (const path of ['', '/preview', '/errors']) {
        await http()
          .get(`/imports/${id}${path}`)
          .set(bearer(second))
          .expect(404);
      }
      await http()
        .post(`/imports/${id}/confirm`)
        .set(bearer(second))
        .send({ schemaVersion: 1, previewHash: preview.body.job.previewHash })
        .expect(404);
      const list = await http().get('/imports').set(bearer(second)).expect(200);
      expect(list.body.meta.total).toBe(0);
    });

    it('sets no-store on imports responses', async () => {
      const response = await http()
        .get('/imports/types')
        .set(bearer(staff))
        .expect(200);
      expect(response.headers['cache-control']).toBe('no-store');
    });
  });

  describe('lifecycle', () => {
    async function readyJob(sku: string, token = admin) {
      const category = await getCategory(ctx.prisma);
      const preview = await upload(
        csv([`Mug,${sku},${category.name},10,,,,,`]),
        token,
      ).expect(201);
      const id = preview.body.job.id as string;
      return {
        id,
        number: Number(id.slice(4)),
        body: {
          schemaVersion: 1,
          previewHash: preview.body.job.previewHash as string,
        },
      };
    }

    it('expires a preview: 410 for its rows and for confirmation', async () => {
      const job = await readyJob('E-1');
      await ctx.prisma.importJob.update({
        where: { number: job.number },
        data: { previewExpiresAt: new Date(Date.now() - 1000) },
      });

      await http()
        .get(`/imports/${job.id}/preview`)
        .set(bearer(admin))
        .expect(410);
      await http()
        .post(`/imports/${job.id}/confirm`)
        .set(bearer(admin))
        .send(job.body)
        .expect(410);

      const detail = await http()
        .get(`/imports/${job.id}`)
        .set(bearer(admin))
        .expect(200);
      expect(detail.body.status).toBe('EXPIRED');
      expect(detail.body.previewHash).toBeNull();
      const stored = await ctx.prisma.importJob.findUniqueOrThrow({
        where: { number: job.number },
      });
      expect(stored.previewPayload).toBeNull();
      expect(await ctx.prisma.product.count()).toBe(0);
    });

    it('serves a completed replay after its preview has expired', async () => {
      const job = await readyJob('E-2');
      await http()
        .post(`/imports/${job.id}/confirm`)
        .set(bearer(admin))
        .send(job.body)
        .expect(200);
      await ctx.prisma.importJob.update({
        where: { number: job.number },
        data: { previewExpiresAt: new Date(Date.now() - 1000) },
      });

      const replay = await http()
        .post(`/imports/${job.id}/confirm`)
        .set(bearer(admin))
        .send(job.body)
        .expect(200);

      expect(replay.body.job.status).toBe('COMPLETED');
      expect(await ctx.prisma.product.count()).toBe(1);
    });

    it('expires the diagnostic report separately from the preview', async () => {
      const category = await getCategory(ctx.prisma);
      const preview = await upload(
        csv([
          `Bad,R-1,${category.name},not-a-price,,,,,`,
          `Mug,R-2,${category.name},1,,,,,`,
        ]),
      ).expect(201);
      const id = preview.body.job.id as string;
      await ctx.prisma.importJob.update({
        where: { number: Number(id.slice(4)) },
        data: { errorsExpiresAt: new Date(Date.now() - 1000) },
      });

      await http().get(`/imports/${id}/errors`).set(bearer(admin)).expect(410);
      await http()
        .get(`/imports/${id}/errors?format=csv`)
        .set(bearer(admin))
        .expect(410);
    });

    it('returns an abandoned attempt to a retryable failure and lets the same job finish', async () => {
      const job = await readyJob('L-1');
      await ctx.prisma.importJob.update({
        where: { number: job.number },
        data: {
          status: 'PROCESSING',
          attemptToken: randomUUID(),
          attemptExpiresAt: new Date(Date.now() - 5000),
          startedAt: new Date(Date.now() - 65_000),
        },
      });

      const detail = await http()
        .get(`/imports/${job.id}`)
        .set(bearer(admin))
        .expect(200);

      expect(detail.body).toMatchObject({
        status: 'FAILED',
        retryable: true,
        failureCode: 'INTERRUPTED',
        importedRows: 0,
      });
      expect(await ctx.prisma.product.count()).toBe(0);
      expect(detail.body.previewHash).toBe(job.body.previewHash);

      await http()
        .post(`/imports/${job.id}/confirm`)
        .set(bearer(admin))
        .send(job.body)
        .expect(200);
      expect(await ctx.prisma.product.count()).toBe(1);
      expect(await ctx.prisma.productEvent.count()).toBe(1);
    });

    it('leaves a live attempt alone and reports it as processing', async () => {
      const job = await readyJob('L-2');
      await ctx.prisma.importJob.update({
        where: { number: job.number },
        data: {
          status: 'PROCESSING',
          attemptToken: randomUUID(),
          attemptExpiresAt: new Date(Date.now() + 60_000),
          startedAt: new Date(),
        },
      });

      const result = await http()
        .post(`/imports/${job.id}/confirm`)
        .set(bearer(admin))
        .send(job.body)
        .expect(202);

      expect(result.body).toMatchObject({
        processing: true,
        job: { status: 'PROCESSING' },
      });
      expect(await ctx.prisma.product.count()).toBe(0);
    });

    it('cleans up expired data in bounded passes and never touches a live attempt', async () => {
      const expired = await readyJob('C-1');
      const reported = await readyJob('C-2');
      const old = await readyJob('C-3');
      const live = await readyJob('C-4', staff);
      const abandoned = await readyJob('C-5', staff);
      const past = new Date(Date.now() - 1000);
      await ctx.prisma.importJob.update({
        where: { number: expired.number },
        data: { previewExpiresAt: past },
      });
      await ctx.prisma.importJob.update({
        where: { number: reported.number },
        data: { errorsExpiresAt: past },
      });
      await ctx.prisma.importJob.update({
        where: { number: old.number },
        data: { retainUntil: past },
      });
      await ctx.prisma.importJob.update({
        where: { number: live.number },
        data: {
          status: 'PROCESSING',
          attemptToken: randomUUID(),
          attemptExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      await ctx.prisma.importJob.update({
        where: { number: abandoned.number },
        data: {
          status: 'PROCESSING',
          attemptToken: randomUUID(),
          attemptExpiresAt: past,
        },
      });

      const result = await ctx.app.get(ImportsService).cleanup();

      expect(result).toMatchObject({ recovered: 1, deleted: 1 });
      expect(result.purgedReports).toBeGreaterThanOrEqual(1);
      const byNumber = (number: number) =>
        ctx.prisma.importJob.findUnique({ where: { number } });
      expect(await byNumber(old.number)).toBeNull();
      expect(await byNumber(expired.number)).toMatchObject({
        status: 'EXPIRED',
        previewPayload: null,
      });
      expect(await byNumber(reported.number)).toMatchObject({ errors: null });
      expect(await byNumber(live.number)).toMatchObject({
        status: 'PROCESSING',
      });
      expect(await byNumber(abandoned.number)).toMatchObject({
        status: 'FAILED',
        failureCode: 'INTERRUPTED',
      });
      // A second pass has nothing left to do.
      expect(await ctx.app.get(ImportsService).cleanup()).toEqual({
        recovered: 0,
        purgedReports: 0,
        deleted: 0,
      });
    });
  });
});
