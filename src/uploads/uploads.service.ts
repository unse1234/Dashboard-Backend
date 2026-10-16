import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Env } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';
import {
  IMAGE_WRITE_LOCK,
  isLocalImageKey,
  validateBatch,
  validateImage,
} from './image-validation';

export {
  IMAGE_WRITE_LOCK,
  MAX_IMAGE_BYTES,
  MAX_PRODUCT_IMAGES,
  isLocalImageKey,
} from './image-validation';

export const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
const RECOVERY_INTERVAL_MS = 10 * 60 * 1000;

function within(directory: string, parent: string): boolean {
  const path = relative(parent, directory);
  return (
    path === '' ||
    (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
  );
}

function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error
    ? String(error.code)
    : 'UNKNOWN';
}

/** Disk writes precede DB linking; reference removal precedes disk deletion. */
@Injectable()
export class UploadsService implements OnModuleInit, OnModuleDestroy {
  readonly rootDirectory: string;
  private readonly productsDirectory: string;
  private readonly publicApiUrl: string;
  private readonly logger = new Logger(UploadsService.name);
  private readonly activeWrites = new Set<string>();
  private readonly pendingCleanup = new Set<string>();
  private recoveryTimer?: ReturnType<typeof setInterval>;
  private recovering = false;

  constructor(
    config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
  ) {
    this.rootDirectory = resolve(
      config.getOrThrow('UPLOAD_DIR', { infer: true }),
    );
    if (
      within(this.rootDirectory, resolve('src')) ||
      within(this.rootDirectory, resolve('dist'))
    ) {
      throw new Error('UPLOAD_DIR must be outside src and dist');
    }
    this.productsDirectory = resolve(this.rootDirectory, 'products');
    this.publicApiUrl = (
      config.get('PUBLIC_API_URL', { infer: true }) ||
      `http://localhost:${config.getOrThrow('PORT', { infer: true })}`
    ).replace(/\/+$/, '');
  }

  async onModuleInit(): Promise<void> {
    await fs.mkdir(this.productsDirectory, { recursive: true });
    await this.reconcileOrphans();
    this.recoveryTimer = setInterval(() => {
      void this.reconcileOrphans();
    }, RECOVERY_INTERVAL_MS);
    this.recoveryTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
  }

  publicUrl(reference: string): string {
    return isLocalImageKey(reference)
      ? `${this.publicApiUrl}/uploads/${reference}`
      : reference;
  }

  /** Normalize this API's public URL aliases before enforcing ownership. */
  storageKey(reference: string): string | null {
    if (isLocalImageKey(reference)) return reference;
    try {
      const url = new URL(reference, this.publicApiUrl);
      if (
        url.origin !== new URL(this.publicApiUrl).origin ||
        !url.pathname.startsWith('/uploads/')
      )
        return null;
      const key = decodeURIComponent(url.pathname.slice('/uploads/'.length));
      if (isLocalImageKey(key)) return key;
    } catch {
      /* Invalid references never become filesystem paths. */
    }
    return null;
  }

  validateBatch(files: Express.Multer.File[]): void {
    validateBatch(files);
  }

  /** No key escapes until every write succeeds; partial writes are removed. */
  async saveBatch(files: Express.Multer.File[]): Promise<string[]> {
    validateBatch(files);
    await fs.mkdir(this.productsDirectory, { recursive: true });
    const written: string[] = [];
    try {
      for (const file of files) {
        const key = `products/${randomUUID()}.${validateImage(file)}`;
        this.activeWrites.add(key);
        try {
          const handle = await fs.open(this.filePath(key), 'wx', 0o644);
          written.push(key);
          try {
            await handle.writeFile(file.buffer);
          } finally {
            await handle.close();
          }
        } finally {
          this.activeWrites.delete(key);
        }
      }
      return written;
    } catch (error) {
      // These newly generated files cannot have DB references: the caller has
      // not received their keys. Do not hide the write failure if unlink fails.
      for (const key of written) await this.unlink(key);
      throw error;
    }
  }

  /** Best effort after commit; failed cleanup is retried without failing the API. */
  async cleanupUnreferenced(references: string[]): Promise<void> {
    const keys = [...new Set(references.map((key) => this.storageKey(key)))]
      .filter((key): key is string => key !== null)
      .filter((key) => !this.activeWrites.has(key));
    for (let offset = 0; offset < keys.length; offset += 50) {
      const batch = keys.slice(offset, offset + 50);
      for (const key of batch) this.pendingCleanup.add(key);
      try {
        await this.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${IMAGE_WRITE_LOCK})`;
          const aliases = batch.flatMap((key) => [
            key,
            `/uploads/${key}`,
            this.publicUrl(key),
          ]);
          // Deliberately includes archived products: archive is not a hard delete.
          const products = await tx.product.findMany({
            where: {
              OR: [
                { imageUrl: { in: aliases } },
                { galleryUrls: { hasSome: aliases } },
              ],
            },
            select: { imageUrl: true, galleryUrls: true },
          });
          const referenced = new Set(
            products
              .flatMap((product) => [
                ...(product.imageUrl ? [product.imageUrl] : []),
                ...product.galleryUrls,
              ])
              .map((reference) => this.storageKey(reference)),
          );
          for (const key of batch) {
            if (referenced.has(key)) {
              this.pendingCleanup.delete(key);
            } else if (!this.activeWrites.has(key)) {
              await this.unlink(key);
            }
          }
        });
      } catch (error) {
        this.logger.warn(
          `Image cleanup deferred for ${batch.length} file(s) (${errorCode(error)}); recovery will retry`,
        );
      }
    }
  }

  /** Recover crash orphans after a grace period; retry known failures immediately. */
  async reconcileOrphans(): Promise<void> {
    if (this.recovering) return;
    this.recovering = true;
    try {
      const candidates = new Set(this.pendingCleanup);
      const entries = await fs.readdir(this.productsDirectory, {
        withFileTypes: true,
      });
      for (const entry of entries) {
        const key = `products/${entry.name}`;
        if (
          !entry.isFile() ||
          !isLocalImageKey(key) ||
          this.activeWrites.has(key)
        ) {
          continue;
        }
        try {
          const stat = await fs.stat(this.filePath(key));
          if (Date.now() - stat.mtimeMs >= ORPHAN_GRACE_MS) candidates.add(key);
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') {
            this.logger.warn(
              `Could not inspect upload ${key} (${errorCode(error)})`,
            );
          }
        }
      }
      await this.cleanupUnreferenced([...candidates]);
    } catch (error) {
      this.logger.warn(
        `Upload recovery deferred (${errorCode(error)}); recovery will retry`,
      );
    } finally {
      this.recovering = false;
    }
  }

  private filePath(key: string): string {
    if (!isLocalImageKey(key)) throw new Error('Invalid managed image key');
    return resolve(this.rootDirectory, key);
  }

  private async unlink(key: string): Promise<void> {
    try {
      await fs.unlink(this.filePath(key));
      this.pendingCleanup.delete(key);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        this.pendingCleanup.delete(key);
        return;
      }
      this.pendingCleanup.add(key);
      this.logger.warn(
        `Could not delete upload ${key} (${errorCode(error)}); recovery will retry`,
      );
    }
  }
}
