import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { JPEG, WEBP } from './fixtures/product-images';
import { validate } from '../src/config/env.validation';
import { UploadsService } from '../src/uploads/uploads.service';
import {
  bearer,
  createProduct,
  createTestApp,
  createUser,
  login,
  resetDatabase,
  type TestContext,
} from './helpers';

jest.setTimeout(30_000);

// A complete 1 x 1 PNG, rather than a buffer with only a PNG magic number.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const PUBLIC_API_URL = 'http://images.example.test';

interface ProductImage {
  id: string;
  url: string;
  isCover: boolean;
  position: number;
}

interface ImageMutation {
  data: ProductImage[];
  product: {
    id: string;
    imageUrl: string | null;
    galleryUrls: string[];
    version: number;
  };
}

describe('Product image uploads (e2e)', () => {
  let ctx: TestContext;
  let rootDirectory: string;
  let uploads: UploadsService;
  let admin: string;
  let staff: string;
  let unverified: string;
  const http = () => request(ctx.app.getHttpServer());
  const productId = (product: { number: number }) => `PRD-${product.number}`;
  const imagesPath = (product: { number: number }) =>
    `/products/${productId(product)}/images`;
  const upload = (
    product: { number: number },
    files: Buffer[] = [PNG],
    token = admin,
  ) => {
    const pending = http().post(imagesPath(product)).set(bearer(token));
    for (const [index, file] of files.entries()) {
      pending.attach('images', file, {
        filename: `image-${index}.png`,
        contentType: 'image/png',
      });
    }
    return pending;
  };
  const imageFiles = async () => {
    const paths = await readdir(rootDirectory, { recursive: true });
    return paths.filter((path) => /\.(?:jpe?g|png|webp)$/.test(path)).sort();
  };
  const imageList = async (product: { number: number }) => {
    const response = await http()
      .get(imagesPath(product))
      .set(bearer(admin))
      .expect(200);
    return (response.body as { data: ProductImage[] }).data;
  };

  beforeAll(async () => {
    rootDirectory = await mkdtemp(join(tmpdir(), 'product-images-e2e-'));
    const config = new ConfigService(
      validate({ ...process.env, UPLOAD_DIR: rootDirectory, PUBLIC_API_URL }),
    );
    ctx = await createTestApp((builder) => {
      builder.overrideProvider(ConfigService).useValue(config);
    });
    uploads = ctx.app.get(UploadsService);
    await resetDatabase(ctx.prisma);
    await createUser(ctx.prisma, {
      email: 'images-admin@example.com',
      role: 'ADMIN',
    });
    await createUser(ctx.prisma, {
      email: 'images-staff@example.com',
      role: 'STAFF',
    });
    await createUser(ctx.prisma, {
      email: 'images-unverified@example.com',
      verified: false,
    });
    admin = (await login(ctx.app, 'images-admin@example.com')).accessToken;
    staff = (await login(ctx.app, 'images-staff@example.com')).accessToken;
    unverified = (await login(ctx.app, 'images-unverified@example.com'))
      .accessToken;
  });

  beforeEach(async () => {
    await ctx.prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ProductEvent", "OrderEvent", "OrderItem", "EmailJob", "StorefrontToken", "Order", "Product"',
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    if (ctx) {
      await resetDatabase(ctx.prisma);
      await ctx.close();
    }
    if (rootDirectory)
      await rm(rootDirectory, { recursive: true, force: true });
  });

  it('requires a live, verified account for every image metadata and mutation route', async () => {
    const product = await createProduct(ctx.prisma);
    for (const token of [undefined, 'invalid-token', unverified]) {
      const expected = token === unverified ? 403 : 401;
      for (const method of ['get', 'post', 'delete'] as const) {
        const path = `${imagesPath(product)}${method === 'delete' ? `/${randomUUID()}` : ''}`;
        const pending = http()[method](path);
        if (token) pending.set(bearer(token));
        if (method === 'post') {
          pending.attach('images', PNG, 'image.png');
        }
        await pending.expect(expected);
      }
    }
    expect(await imageList(product)).toEqual([]);
  });

  it('lets staff upload a batch, keeps cover/order and serves only public image bytes', async () => {
    const product = await createProduct(ctx.prisma);
    const uploaded = await upload(product, [PNG, PNG], staff).expect(201);
    const body = uploaded.body as ImageMutation;
    expect(body.data).toHaveLength(2);
    expect(
      body.data.map(({ isCover, position }) => ({ isCover, position })),
    ).toEqual([
      { isCover: true, position: 0 },
      { isCover: false, position: 1 },
    ]);
    for (const image of body.data) {
      expect(Object.keys(image).sort()).toEqual([
        'id',
        'isCover',
        'position',
        'url',
      ]);
      expect(image.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(image.url).toBe(
        `${PUBLIC_API_URL}/uploads/products/${image.id}.png`,
      );
      const served = await http().get(new URL(image.url).pathname).expect(200);
      expect(served.headers['content-type']).toMatch(/^image\/png/);
      expect(served.headers['x-content-type-options']).toBe('nosniff');
      expect(served.body).toEqual(PNG);
    }
    expect(body.product.imageUrl).toBe(body.data[0].url);
    expect(body.product.galleryUrls).toEqual([body.data[1].url]);
    expect(body.product.version).toBe(product.version + 1);
    expect(await imageList(product)).toEqual(body.data);

    const stored = await ctx.prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(stored.imageUrl).toBe(`products/${body.data[0].id}.png`);
    expect(stored.galleryUrls).toEqual([`products/${body.data[1].id}.png`]);
    const dashboard = await http()
      .get(`/products/${productId(product)}`)
      .set(bearer(staff))
      .expect(200);
    expect(dashboard.body).toMatchObject(body.product);
    const storefront = await http()
      .get(`/storefront/products/${productId(product)}`)
      .expect(200);
    const storefrontBody = storefront.body as {
      image: { url: string };
      gallery: { url: string }[];
    };
    expect(storefrontBody.image.url).toBe(body.data[0].url);
    expect(storefrontBody.gallery.map((image) => image.url)).toEqual([
      body.data[1].url,
    ]);
    await http().get('/uploads').expect(404);
    await http().get('/uploads/products/').expect(404);
    await http().get('/uploads/.env').expect(404);
  });

  it('derives the extension from bytes and ignores misleading filenames and MIME types', async () => {
    const product = await createProduct(ctx.prisma);
    const response = await http()
      .post(imagesPath(product))
      .set(bearer(admin))
      .attach('images', PNG, {
        filename: '../../misleading.svg',
        contentType: 'image/svg+xml',
      })
      .expect(201);
    const [image] = (response.body as ImageMutation).data;
    expect(image.url).toMatch(/\/uploads\/products\/[0-9a-f-]+\.png$/);
    expect(image.url).not.toContain('misleading');
  });

  it.each([
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ['text disguised as PNG', Buffer.from('this is not an image')],
    ['a signature without image contents', PNG.subarray(0, 8)],
    ['an empty file', Buffer.alloc(0)],
  ])(
    'rejects %s without writing any part of the batch',
    async (_label, invalid) => {
      const product = await createProduct(ctx.prisma);
      const before = await imageFiles();
      const response = await upload(product, [PNG, invalid]).expect(400);
      expect(response.body).toMatchObject({
        statusCode: 400,
        error: 'Bad Request',
        message: expect.any(String),
      });
      expect(await imageList(product)).toEqual([]);
      expect(await imageFiles()).toEqual(before);
    },
  );

  it('bounds multipart fields, file counts and individual file sizes', async () => {
    const product = await createProduct(ctx.prisma);
    const before = await imageFiles();
    await http().post(imagesPath(product)).set(bearer(admin)).expect(400);
    await http()
      .post(imagesPath(product))
      .set(bearer(admin))
      .attach('file', PNG, 'wrong-field.png')
      .expect(400);
    await upload(
      product,
      Array.from({ length: 9 }, () => PNG),
    ).expect(400);
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1);
    PNG.copy(oversized);
    await upload(product, [oversized]).expect(413);
    expect(await imageList(product)).toEqual([]);
    expect(await imageFiles()).toEqual(before);
  });

  it('returns 404 for missing or archived products and image ids owned by another product', async () => {
    await upload({ number: 2147483647 }).expect(404);
    const archived = await createProduct(ctx.prisma, { archived: true });
    await upload(archived).expect(404);
    const first = await createProduct(ctx.prisma);
    const second = await createProduct(ctx.prisma);
    const uploaded = await upload(first).expect(201);
    const [image] = (uploaded.body as ImageMutation).data;
    for (const id of [image.id, randomUUID()]) {
      const response = await http()
        .delete(`${imagesPath(second)}/${id}`)
        .set(bearer(staff))
        .expect(404);
      expect(response.body.message).toBe('Image not found');
    }
    const rejected = await http()
      .patch(`/products/${productId(second)}`)
      .set(bearer(admin))
      .send({ version: second.version, imageUrl: image.url })
      .expect(400);
    expect(rejected.body.message).toBe(
      'Uploaded images must already belong to this product',
    );
    await http()
      .patch(`/products/${productId(second)}`)
      .set(bearer(admin))
      .send({
        version: second.version,
        imageUrl: `${image.url}?cache=1#preview`,
      })
      .expect(400);
    await http().get(new URL(image.url).pathname).expect(200);
    expect(await imageList(first)).toEqual([image]);
  });

  it('counts existing external images and permits only one concurrent batch into the last slot', async () => {
    const product = await createProduct(ctx.prisma, {
      imageUrl: 'https://cdn.example.com/cover.jpg',
      galleryUrls: Array.from(
        { length: 6 },
        (_, index) => `https://cdn.example.com/view-${index}.jpg`,
      ),
    });
    const before = await imageFiles();
    const responses = await Promise.all([upload(product), upload(product)]);
    expect(responses.map(({ status }) => status).sort()).toEqual([201, 400]);
    const rejected = responses.find(({ status }) => status === 400);
    expect(rejected?.body.message).toBe('A product can have at most 8 images');
    const images = await imageList(product);
    expect(images).toHaveLength(8);
    expect(images[0]).toMatchObject({
      url: 'https://cdn.example.com/cover.jpg',
      isCover: true,
      position: 0,
    });
    expect(images[0].id).toMatch(/^ext-[0-9a-f]+$/);
    expect(await imageFiles()).toHaveLength(before.length + 1);
    await upload(product).expect(400);
    expect(await imageFiles()).toHaveLength(before.length + 1);
  });

  it('reorders existing images through PATCH, then promotes the next cover on deletion', async () => {
    const product = await createProduct(ctx.prisma);
    const uploaded = await upload(product, [PNG, PNG, PNG]).expect(201);
    const body = uploaded.body as ImageMutation;
    const [first, second, third] = body.data;
    const reordered = await http()
      .patch(`/products/${productId(product)}`)
      .set(bearer(staff))
      .send({
        version: body.product.version,
        imageUrl: third.url,
        galleryUrls: [first.url, second.url],
      })
      .expect(200);
    expect(reordered.body.imageUrl).toBe(third.url);
    const removed = await http()
      .delete(`${imagesPath(product)}/${third.id}`)
      .set(bearer(staff))
      .expect(200);
    const remaining = removed.body as ImageMutation;
    expect(remaining.data).toEqual([
      { ...first, position: 0, isCover: true },
      { ...second, position: 1, isCover: false },
    ]);
    expect(remaining.product.imageUrl).toBe(first.url);
    expect(remaining.product.galleryUrls).toEqual([second.url]);
    expect(remaining.product.version).toBe(body.product.version + 2);
    await http().get(new URL(third.url).pathname).expect(404);
    await http().get(new URL(first.url).pathname).expect(200);
  });

  it('preserves files referenced by another product and external references during deletion', async () => {
    const product = await createProduct(ctx.prisma);
    const uploaded = await upload(product).expect(201);
    const [image] = (uploaded.body as ImageMutation).data;
    await createProduct(ctx.prisma, {
      imageUrl: uploads.storageKey(image.url),
      archived: true,
    });
    await http()
      .delete(`${imagesPath(product)}/${image.id}`)
      .set(bearer(admin))
      .expect(200);
    await http().get(new URL(image.url).pathname).expect(200);

    const external = await createProduct(ctx.prisma, {
      imageUrl: 'https://cdn.example.com/uploads/products/old.png',
      galleryUrls: ['/products/legacy.png'],
    });
    const [cover, gallery] = await imageList(external);
    const deleted = await http()
      .delete(`${imagesPath(external)}/${cover.id}`)
      .set(bearer(admin))
      .expect(200);
    expect((deleted.body as ImageMutation).data).toEqual([
      { ...gallery, isCover: true, position: 0 },
    ]);
    expect(await imageList(external)).toEqual(
      (deleted.body as ImageMutation).data,
    );
  });

  it('serves JPEG and WebP with their validated content types', async () => {
    const product = await createProduct(ctx.prisma);
    const response = await upload(product, [JPEG, WEBP]).expect(201);
    for (const [index, type] of ['jpeg', 'webp'].entries()) {
      const image = (response.body as ImageMutation).data[index];
      const file = await http().get(new URL(image.url).pathname).expect(200);
      expect(file.headers['content-type']).toBe(`image/${type}`);
      expect(file.headers['cross-origin-resource-policy']).toBe('cross-origin');
    }
  });

  it('replaces a full product image slot without deleting the old file before commit', async () => {
    const product = await createProduct(ctx.prisma);
    const response = await upload(
      product,
      Array.from({ length: 8 }, () => PNG),
    ).expect(201);
    const [cover] = (response.body as ImageMutation).data;
    const saveBatch = uploads.saveBatch.bind(uploads);
    jest.spyOn(uploads, 'saveBatch').mockImplementationOnce(async (files) => {
      await http().get(new URL(cover.url).pathname).expect(200);
      return saveBatch(files);
    });
    const replaced = await http()
      .post(imagesPath(product))
      .query({ replaceImageId: cover.id })
      .set(bearer(staff))
      .attach('images', PNG, 'new.png')
      .expect(201);
    const result = replaced.body as ImageMutation;
    expect(result.data).toHaveLength(8);
    expect(result.data[0]).toMatchObject({ isCover: true, position: 0 });
    expect(result.data[0].id).not.toBe(cover.id);
    expect(result.data.slice(1)).toEqual(
      (response.body as ImageMutation).data.slice(1),
    );
    const missing = await http().get(new URL(cover.url).pathname).expect(404);
    expect(missing.body).toEqual({
      statusCode: 404,
      message: 'Image not found',
      error: 'Not Found',
    });
    expect(JSON.stringify(missing.body)).not.toContain(rootDirectory);
  });

  it('validates replacement ownership and batch size', async () => {
    const product = await createProduct(ctx.prisma);
    const [image] = (await upload(product).expect(201)).body
      .data as ProductImage[];
    const other = await createProduct(ctx.prisma);
    await http()
      .post(imagesPath(other))
      .query({ replaceImageId: image.id })
      .set(bearer(admin))
      .attach('images', PNG, 'new.png')
      .expect(404);
    await http()
      .post(imagesPath(product))
      .query({ replaceImageId: image.id })
      .set(bearer(admin))
      .attach('images', PNG, '1.png')
      .attach('images', PNG, '2.png')
      .expect(400);
    await http().get(new URL(image.url).pathname).expect(200);
  });

  it('enforces total image limits on URL writes and preserves existing valid URLs', async () => {
    const category = await ctx.prisma.category.findFirstOrThrow();
    await http()
      .post('/products')
      .set(bearer(admin))
      .send({
        name: 'Too many images',
        sku: 'IMAGES-LIMIT',
        categoryId: category.id,
        price: 10,
        imageUrl: '/cover.png',
        galleryUrls: Array.from({ length: 8 }, (_, i) => `/view-${i}.png`),
      })
      .expect(400);
    const product = await createProduct(ctx.prisma, {
      imageUrl: 'https://cdn.example.com/cover.jpg',
      galleryUrls: ['/products/legacy.png'],
    });
    const response = await http()
      .get(`/products/${productId(product)}`)
      .set(bearer(admin))
      .expect(200);
    expect(response.body.imageUrl).toBe('https://cdn.example.com/cover.jpg');
    expect(response.body.galleryUrls).toEqual(['/products/legacy.png']);
    await http()
      .patch(`/products/${productId(product)}`)
      .set(bearer(admin))
      .send({
        version: product.version,
        galleryUrls: Array.from({ length: 8 }, (_, i) => `/view-${i}.png`),
      })
      .expect(400);
  });

  it('keeps archived product files and hides their image mutation routes', async () => {
    const product = await createProduct(ctx.prisma);
    const [image] = (await upload(product).expect(201)).body
      .data as ProductImage[];
    await http()
      .post('/products/archive')
      .set(bearer(admin))
      .send({ productIds: [productId(product)] })
      .expect(200);
    await uploads.cleanupUnreferenced([uploads.storageKey(image.url)!]);
    await http().get(new URL(image.url).pathname).expect(200);
    await http()
      .delete(`${imagesPath(product)}/${image.id}`)
      .set(bearer(admin))
      .expect(404);
  });

  it('removes files saved by a batch whose database transaction fails', async () => {
    const product = await createProduct(ctx.prisma);
    const before = await imageFiles();
    const save = jest.spyOn(uploads, 'saveBatch');
    const originalTransaction = ctx.prisma.$transaction.bind(ctx.prisma);
    jest
      .spyOn(ctx.prisma, '$transaction')
      .mockImplementationOnce(
        async (
          operation: (
            tx: import('../src/prisma/prisma.service').Db,
          ) => Promise<unknown>,
        ) =>
          originalTransaction(async (tx) => {
            await operation(tx);
            throw new Error('Injected database failure');
          }),
      );
    await upload(product, [PNG, PNG]).expect(500);
    expect(save).toHaveBeenCalledTimes(1);
    expect(await imageFiles()).toEqual(before);
    const unchanged = await ctx.prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(unchanged).toMatchObject({
      imageUrl: null,
      galleryUrls: [],
      version: product.version,
    });
    expect(await ctx.prisma.productEvent.count()).toBe(0);
  });
});
