import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaService } from '../prisma/prisma.service';
import type { Db } from '../prisma/prisma.service';
import { imageFile, PNG } from '../../test/fixtures/product-images';
import { ORPHAN_GRACE_MS, UploadsService } from './uploads.service';

describe('filesystem uploads', () => {
  let root: string;
  let service: UploadsService;
  const findMany = jest.fn();
  const transaction = jest.fn((operation: (tx: Db) => Promise<void>) =>
    operation({
      $executeRaw: jest.fn(),
      product: { findMany },
    } as unknown as Db),
  );

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'uploads-unit-'));
    findMany.mockReset().mockResolvedValue([]);
    transaction.mockClear();
    service = new UploadsService(
      new ConfigService({
        UPLOAD_DIR: root,
        PUBLIC_API_URL: 'https://api.example.com',
        PORT: 3001,
      }),
      { $transaction: transaction } as unknown as PrismaService,
    );
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await service.onModuleInit();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    service.onModuleDestroy();
    // root is the resolved result of mkdtemp under the OS temp directory.
    await fs.rm(root, { recursive: true, force: true });
  });

  it('stores generated relative keys with byte-derived extensions and resolves URLs', async () => {
    const [key] = await service.saveBatch([imageFile()]);
    expect(key).toMatch(/^products\/[0-9a-f-]{36}\.png$/);
    expect(await fs.readFile(join(root, key))).toEqual(PNG);
    const url = `https://api.example.com/uploads/${key}`;
    expect(service.publicUrl(key)).toBe(url);
    expect(service.storageKey(url)).toBe(key);
    expect(service.storageKey(`${url}?cache=1#preview`)).toBe(key);
    expect(service.storageKey(`/uploads/${key}`)).toBe(key);
    expect(
      service.storageKey(`https://external.example/uploads/${key}`),
    ).toBeNull();
    expect(service.storageKey(`/uploads/../${key}`)).toBeNull();
    expect(service.publicUrl('/products/legacy.png')).toBe(
      '/products/legacy.png',
    );
  });

  it('cleans a partial batch when a later write fails', async () => {
    const open = fs.open.bind(fs);
    jest
      .spyOn(fs, 'open')
      .mockImplementationOnce(open)
      .mockRejectedValueOnce(new Error('disk full'));
    await expect(service.saveBatch([imageFile(), imageFile()])).rejects.toThrow(
      'disk full',
    );
    expect(await fs.readdir(join(root, 'products'))).toEqual([]);
  });

  it('does not write any files for a rejected batch', async () => {
    await expect(
      service.saveBatch([imageFile(), imageFile(Buffer.from('<svg/>'))]),
    ).rejects.toThrow();
    expect(await fs.readdir(join(root, 'products'))).toEqual([]);
  });

  it('keeps shared/archived image references and ignores external references', async () => {
    const [key] = await service.saveBatch([imageFile()]);
    findMany.mockResolvedValue([{ imageUrl: key, galleryUrls: [] }]);
    await service.cleanupUnreferenced([key]);
    expect(await fs.readFile(join(root, key))).toEqual(PNG);
    const unlink = jest.spyOn(fs, 'unlink');
    await service.cleanupUnreferenced([
      `https://external.example/uploads/${key}`,
      '../../outside.png',
    ]);
    expect(unlink).not.toHaveBeenCalled();
    const query = findMany.mock.calls[0][0] as { where: object };
    expect(JSON.stringify(query.where)).not.toContain('archivedAt');
    findMany.mockResolvedValue([]);
    await service.cleanupUnreferenced([key]);
    await expect(fs.stat(join(root, key))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('logs failed cleanup and retries it without failing the committed request', async () => {
    const [key] = await service.saveBatch([imageFile()]);
    jest
      .spyOn(fs, 'unlink')
      .mockRejectedValueOnce(
        Object.assign(new Error('busy'), { code: 'EBUSY' }),
      );
    await expect(service.cleanupUnreferenced([key])).resolves.toBeUndefined();
    expect(Logger.prototype.warn).toHaveBeenCalled();
    await service.reconcileOrphans();
    await expect(fs.stat(join(root, key))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('recovers old crash orphans but preserves recent and referenced files', async () => {
    const [old, recent, referenced] = await service.saveBatch([
      imageFile(),
      imageFile(),
      imageFile(),
    ]);
    const past = new Date(Date.now() - ORPHAN_GRACE_MS - 1000);
    await fs.utimes(join(root, old), past, past);
    await fs.utimes(join(root, referenced), past, past);
    findMany.mockResolvedValue([{ imageUrl: referenced, galleryUrls: [] }]);
    await service.reconcileOrphans();
    await expect(fs.stat(join(root, old))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await fs.readFile(join(root, recent))).toEqual(PNG);
    expect(await fs.readFile(join(root, referenced))).toEqual(PNG);
  });
});
