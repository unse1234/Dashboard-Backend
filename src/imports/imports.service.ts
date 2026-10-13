import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  HttpException,
  HttpStatus,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../common/authenticated-user';
import { sha256 } from '../common/crypto.util';
import { formatPublicId } from '../common/public-id';
import {
  ImportJobStatus,
  Prisma,
  type ImportJob,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { createProductsInTransaction } from '../products/product-create';
import { parseProductCsv } from './csv.parser';
import {
  ERRORS_TTL_MS,
  HISTORY_TTL_MS,
  IMPORT_LOCK_NAMESPACE,
  IMPORT_MAX_ERRORS_BYTES,
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_PREVIEW_BYTES,
  IMPORT_MAX_ROWS,
  IMPORT_SCHEMA_VERSION,
  PREVIEW_TTL_MS,
  PRODUCT_IMPORT_COLUMNS,
  REQUIRED_PRODUCT_COLUMNS,
} from './import.constants';
import { analyzeProductRows } from './product-import';
import type { ImportPreviewPayload, RowIssue } from './import.types';
import type { PreviewImportDto } from './dto/preview-import.dto';
import type { ConfirmImportDto } from './dto/confirm-import.dto';
import type { ListImportsQueryDto } from './dto/list-imports-query.dto';

type JobRow = ImportJob & { initiatedBy: { name: string } };
const owner = { initiatedBy: { select: { name: true } } } as const;

class BusinessConflict extends Error {
  constructor(readonly issues: RowIssue[]) {
    super('The catalogue changed after validation. Validate the CSV again.');
  }
}

function storedIssues(job: ImportJob): RowIssue[] {
  return Array.isArray(job.errors) ? (job.errors as unknown as RowIssue[]) : [];
}

function storedPayload(job: ImportJob): ImportPreviewPayload | null {
  if (
    !job.previewPayload ||
    Array.isArray(job.previewPayload) ||
    typeof job.previewPayload !== 'object' ||
    !('rows' in job.previewPayload)
  )
    return null;
  return job.previewPayload as unknown as ImportPreviewPayload;
}

function page<T>(items: T[], pageNumber: number, pageSize: number) {
  const total = items.length;
  return {
    data: items.slice((pageNumber - 1) * pageSize, pageNumber * pageSize),
    meta: {
      page: pageNumber,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  };
}

function summary(job: JobRow, actor: AuthenticatedUser) {
  const issues = storedIssues(job);
  return {
    id: formatPublicId('IMP', job.number),
    type: job.type,
    status: job.status,
    filename: job.originalFilename,
    initiatedBy: {
      name: job.initiatedBy.name,
      isCurrentUser: job.initiatedById === actor.id,
    },
    totalRows: job.totalRows,
    validRows: job.validRows,
    invalidRows: job.invalidRows,
    importedRows: job.importedRows,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    previewExpiresAt: job.previewExpiresAt.toISOString(),
    errorsExpiresAt: job.errorsExpiresAt.toISOString(),
    retryable: job.retryable && job.previewExpiresAt > new Date(),
    failureCode: job.failureCode,
    failureMessage: job.failureMessage,
    sampleErrors: issues.slice(0, 3),
    errorCount: issues.length,
  };
}

function details(job: JobRow, actor: AuthenticatedUser) {
  return {
    ...summary(job, actor),
    schemaVersion: job.schemaVersion,
    previewHash:
      job.initiatedById === actor.id &&
      job.previewExpiresAt > new Date() &&
      ['READY', 'FAILED'].includes(job.status) &&
      (job.status === 'READY' || job.retryable)
        ? job.previewHash
        : null,
    createdProductIds: Array.isArray(job.createdProductNumbers)
      ? (job.createdProductNumbers as number[]).map((number) =>
          formatPublicId('PRD', number),
        )
      : [],
  };
}

function safeFilename(raw: string): string {
  return (
    (raw.split(/[\\/]/).at(-1) ?? 'products.csv')
      .replaceAll(/[\p{Cc}]/gu, '')
      .slice(0, 160) || 'products.csv'
  );
}

@Injectable()
export class ImportsService {
  constructor(private readonly prisma: PrismaService) {}

  types() {
    return {
      data: [
        {
          type: 'PRODUCTS',
          label: 'Products',
          mode: 'CREATE_ONLY',
          schemaVersion: IMPORT_SCHEMA_VERSION,
          extensions: ['.csv'],
          mimeTypes: ['text/csv'],
          maxFileBytes: IMPORT_MAX_FILE_BYTES,
          maxRows: IMPORT_MAX_ROWS,
          previewTtlSeconds: PREVIEW_TTL_MS / 1000,
          columns: PRODUCT_IMPORT_COLUMNS.map((name) => ({
            name,
            required: REQUIRED_PRODUCT_COLUMNS.includes(name),
          })),
        },
      ],
    };
  }

  private async find(
    number: number,
    actor: AuthenticatedUser,
  ): Promise<JobRow> {
    const job = await this.prisma.importJob.findUnique({
      where: { number },
      include: owner,
    });
    if (!job || (actor.role !== 'ADMIN' && job.initiatedById !== actor.id)) {
      throw new NotFoundException('Import not found');
    }
    return job;
  }

  private async expirePreview(): Promise<void> {
    const now = new Date();
    await this.prisma.importJob.updateMany({
      where: {
        status: { in: ['READY', 'VALIDATION_FAILED', 'FAILED'] },
        previewExpiresAt: { lt: now },
      },
      data: {
        status: 'EXPIRED',
        previewPayload: Prisma.DbNull,
        retryable: false,
      },
    });
  }

  async preview(
    actor: AuthenticatedUser,
    input: PreviewImportDto,
    file: Express.Multer.File | undefined,
  ) {
    if (!file) throw new BadRequestException('Choose one CSV file.');
    if (input.type !== 'PRODUCTS')
      throw new BadRequestException('Only product imports are available.');
    const fileHash = createHash('sha256').update(file.buffer).digest('hex');
    const requestHash = sha256(`PRODUCTS:${IMPORT_SCHEMA_VERSION}:${fileHash}`);
    const previous = await this.prisma.importJob.findUnique({
      where: {
        initiatedById_clientRequestId: {
          initiatedById: actor.id,
          clientRequestId: input.clientRequestId,
        },
      },
      include: owner,
    });
    if (previous) {
      if (previous.requestHash !== requestHash)
        throw new ConflictException(
          'This upload key was used for another file.',
        );
      return { replayed: true, result: this.previewResponse(previous, actor) };
    }

    const parsed = await parseProductCsv(
      file.buffer,
      file.originalname,
      file.mimetype,
    );
    const checked = await analyzeProductRows(parsed, this.prisma);
    const serialized = JSON.stringify(checked.payload);
    const errors = JSON.stringify(checked.issues);
    if (
      Buffer.byteLength(serialized) > IMPORT_MAX_PREVIEW_BYTES ||
      Buffer.byteLength(errors) > IMPORT_MAX_ERRORS_BYTES
    ) {
      throw new PayloadTooLargeException(
        'The CSV contains too much product data.',
      );
    }
    const now = Date.now();
    const previewHash = sha256(
      `PRODUCTS:${IMPORT_SCHEMA_VERSION}:CREATE_ONLY:${serialized}`,
    );
    let created: JobRow;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(${IMPORT_LOCK_NAMESPACE + 1}, hashtext(${actor.id}))::text`;
        // Only previews that still hold their normalized rows count; a
        // completed or conflicted job has purged them already.
        const openCount = await tx.importJob.count({
          where: {
            initiatedById: actor.id,
            status: {
              in: ['READY', 'VALIDATION_FAILED', 'PROCESSING', 'FAILED'],
            },
            previewExpiresAt: { gt: new Date() },
            previewPayload: { not: Prisma.DbNull },
          },
        });
        if (openCount >= 3)
          throw new HttpException(
            'Finish or wait for an existing preview to expire.',
            HttpStatus.TOO_MANY_REQUESTS,
          );
        return tx.importJob.create({
          data: {
            type: 'PRODUCTS',
            status: checked.issues.length ? 'VALIDATION_FAILED' : 'READY',
            initiatedById: actor.id,
            originalFilename: safeFilename(file.originalname),
            fileSizeBytes: file.size,
            fileSha256: fileHash,
            clientRequestId: input.clientRequestId,
            requestHash,
            previewHash,
            totalRows: checked.payload.rows.length,
            validRows: checked.validRows.length,
            invalidRows: checked.payload.rows.length - checked.validRows.length,
            previewPayload: checked.payload as unknown as Prisma.InputJsonValue,
            errors: checked.issues as unknown as Prisma.InputJsonValue,
            previewExpiresAt: new Date(now + PREVIEW_TTL_MS),
            errorsExpiresAt: new Date(now + ERRORS_TTL_MS),
            retainUntil: new Date(now + HISTORY_TTL_MS),
          },
          include: owner,
        });
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const replay = await this.prisma.importJob.findUnique({
          where: {
            initiatedById_clientRequestId: {
              initiatedById: actor.id,
              clientRequestId: input.clientRequestId,
            },
          },
          include: owner,
        });
        if (replay && replay.requestHash === requestHash)
          return {
            replayed: true,
            result: this.previewResponse(replay, actor),
          };
        throw new ConflictException(
          'This upload key was used for another file.',
        );
      }
      throw error;
    }
    return { replayed: false, result: this.previewResponse(created, actor) };
  }

  private previewResponse(job: JobRow, actor: AuthenticatedUser) {
    const payload = storedPayload(job);
    return {
      job: details(job, actor),
      mapping: payload?.mapping ?? {},
      preview: page(payload?.rows ?? [], 1, 25),
      errors: page(storedIssues(job), 1, 25),
    };
  }

  async list(actor: AuthenticatedUser, query: ListImportsQueryDto) {
    if (query.scope === 'all' && actor.role !== 'ADMIN')
      throw new ForbiddenException('Insufficient permissions');
    await this.expirePreview();
    const scoped: Prisma.ImportJobWhereInput =
      query.scope === 'all' ? {} : { initiatedById: actor.id };
    const where = {
      ...scoped,
      ...(query.status ? { status: query.status } : {}),
    };
    const [total, jobs, groups] = await Promise.all([
      this.prisma.importJob.count({ where }),
      this.prisma.importJob.findMany({
        where,
        include: owner,
        orderBy: [{ createdAt: 'desc' }, { number: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.importJob.groupBy({
        by: ['status'],
        where: scoped,
        _count: { _all: true },
      }),
    ]);
    const statusCounts = Object.fromEntries(
      Object.values(ImportJobStatus).map((status) => [
        status,
        groups.find((group) => group.status === status)?._count._all ?? 0,
      ]),
    );
    return {
      data: jobs.map((job) => summary(job, actor)),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
        statusCounts,
      },
    };
  }

  async get(actor: AuthenticatedUser, number: number) {
    await this.find(number, actor);
    await this.recover(number);
    await this.expirePreview();
    return details(await this.find(number, actor), actor);
  }

  async getPreview(
    actor: AuthenticatedUser,
    number: number,
    pageNumber: number,
    pageSize: number,
  ) {
    if (pageSize > 50)
      throw new BadRequestException(
        'Preview pages may contain at most 50 rows.',
      );
    const job = await this.find(number, actor);
    if (job.previewExpiresAt <= new Date())
      throw new GoneException('The preview has expired. Upload the CSV again.');
    const payload = storedPayload(job);
    if (!payload)
      throw new GoneException('The preview is no longer available.');
    return page(payload.rows, pageNumber, pageSize);
  }

  async getErrors(
    actor: AuthenticatedUser,
    number: number,
    pageNumber: number,
    pageSize: number,
  ) {
    const job = await this.find(number, actor);
    if (job.errorsExpiresAt <= new Date())
      throw new GoneException('The error report has expired.');
    return page(storedIssues(job), pageNumber, pageSize);
  }

  async allErrors(actor: AuthenticatedUser, number: number) {
    const job = await this.find(number, actor);
    if (job.errorsExpiresAt <= new Date())
      throw new GoneException('The error report has expired.');
    return storedIssues(job);
  }

  private async recover(number: number): Promise<void> {
    const found = await this.prisma.importJob.findUnique({
      where: { number },
      select: { id: true, status: true, attemptExpiresAt: true },
    });
    if (
      !found ||
      found.status !== 'PROCESSING' ||
      !found.attemptExpiresAt ||
      found.attemptExpiresAt > new Date()
    )
      return;
    await this.prisma.$transaction(async (tx) => {
      const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(${IMPORT_LOCK_NAMESPACE}, ${number}) AS locked`;
      if (!lock.locked) return;
      await tx.importJob.updateMany({
        where: {
          id: found.id,
          status: 'PROCESSING',
          attemptExpiresAt: { lt: new Date() },
        },
        data: {
          status: 'FAILED',
          retryable: true,
          failureCode: 'INTERRUPTED',
          failureMessage:
            'Processing was interrupted. You can retry this preview.',
          attemptToken: null,
          attemptExpiresAt: null,
          completedAt: new Date(),
        },
      });
    });
  }

  async confirm(
    actor: AuthenticatedUser,
    number: number,
    input: ConfirmImportDto,
  ): Promise<{ job: ReturnType<typeof details>; processing: boolean }> {
    await this.find(number, actor);
    await this.recover(number);
    const job = await this.find(number, actor);
    if (job.initiatedById !== actor.id)
      throw new NotFoundException('Import not found');
    if (
      input.schemaVersion !== job.schemaVersion ||
      input.previewHash !== job.previewHash
    ) {
      throw new ConflictException(
        'The preview has changed. Validate the CSV again.',
      );
    }
    if (job.status === 'COMPLETED')
      return { job: details(job, actor), processing: false };
    if (job.status === 'PROCESSING')
      return { job: details(job, actor), processing: true };
    if (job.previewExpiresAt <= new Date())
      throw new GoneException('The preview has expired. Upload the CSV again.');
    if (job.status !== 'READY' && !(job.status === 'FAILED' && job.retryable)) {
      throw new ConflictException(
        'This import cannot be confirmed. Correct the CSV and validate it again.',
      );
    }
    const token = randomUUID();
    const claimed = await this.prisma.importJob.updateMany({
      where: {
        id: job.id,
        status: job.status,
        previewExpiresAt: { gt: new Date() },
      },
      data: {
        status: 'PROCESSING',
        attemptToken: token,
        attemptExpiresAt: new Date(Date.now() + 60_000),
        startedAt: new Date(),
        completedAt: null,
        retryable: false,
        failureCode: null,
        failureMessage: null,
      },
    });
    if (claimed.count === 0) return this.confirm(actor, number, input);

    try {
      await this.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(${IMPORT_LOCK_NAMESPACE}, ${number})::text`;
          const [globalLock] = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(${IMPORT_LOCK_NAMESPACE}, 0) AS locked`;
          if (!globalLock.locked)
            throw new HttpException(
              'Another import is processing. Try again shortly.',
              HttpStatus.TOO_MANY_REQUESTS,
            );
          const fresh = await tx.importJob.findUnique({
            where: { id: job.id },
          });
          if (
            !fresh ||
            fresh.status !== 'PROCESSING' ||
            fresh.attemptToken !== token ||
            fresh.previewExpiresAt <= new Date() ||
            !fresh.attemptExpiresAt ||
            fresh.attemptExpiresAt <= new Date()
          ) {
            throw new ConflictException(
              'The import attempt is no longer active.',
            );
          }
          const payload = storedPayload(fresh);
          if (!payload)
            throw new ConflictException('The preview is no longer available.');
          const analyzed = await analyzeProductRows(
            {
              mapping: payload.mapping,
              rows: payload.rows.map((row) => ({
                rowNumber: row.rowNumber,
                cells: row.values,
              })),
            },
            tx,
          );
          if (analyzed.issues.length)
            throw new BusinessConflict(analyzed.issues);
          const numbers = await createProductsInTransaction(
            tx,
            actor,
            analyzed.validRows.map((row) => row.dto),
          );
          const complete = await tx.importJob.updateMany({
            where: { id: job.id, status: 'PROCESSING', attemptToken: token },
            data: {
              status: 'COMPLETED',
              importedRows: fresh.totalRows,
              createdProductNumbers: numbers,
              previewPayload: Prisma.DbNull,
              attemptToken: null,
              attemptExpiresAt: null,
              completedAt: new Date(),
              retryable: false,
            },
          });
          if (complete.count !== 1)
            throw new ConflictException('The import attempt changed.');
        },
        { maxWait: 2000, timeout: 10_000 },
      );
    } catch (error) {
      const current = await this.prisma.importJob
        .findUnique({ where: { id: job.id }, include: owner })
        .catch(() => null);
      if (current?.status === 'COMPLETED')
        return { job: details(current, actor), processing: false };
      if (error instanceof HttpException && error.getStatus() === 429) {
        await this.prisma.importJob.updateMany({
          where: { id: job.id, status: 'PROCESSING', attemptToken: token },
          data: { status: 'READY', attemptToken: null, attemptExpiresAt: null },
        });
        throw error;
      }
      const issues = error instanceof BusinessConflict ? error.issues : [];
      const retryable =
        !(error instanceof BusinessConflict) &&
        !(error instanceof ConflictException) &&
        !(
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        );
      const invalidRows = new Set(issues.map((item) => item.rowNumber)).size;
      await this.prisma.importJob.updateMany({
        where: { id: job.id, status: 'PROCESSING', attemptToken: token },
        data: {
          status: 'FAILED',
          retryable,
          attemptToken: null,
          attemptExpiresAt: null,
          validRows: current
            ? current.totalRows - invalidRows
            : job.totalRows - invalidRows,
          invalidRows,
          errors: issues as unknown as Prisma.InputJsonValue,
          failureCode: retryable ? 'PROCESSING_FAILED' : 'CATALOGUE_CHANGED',
          failureMessage: retryable
            ? 'Processing failed. You can retry this preview.'
            : 'The catalogue changed. Validate the CSV again.',
          previewPayload: retryable ? undefined : Prisma.DbNull,
          completedAt: new Date(),
        },
      });
      if (retryable)
        throw new ServiceUnavailableException(
          'Processing failed. Check the import status before retrying.',
        );
      throw new ConflictException(
        'The catalogue changed. Validate the CSV again.',
      );
    }
    return { job: await this.get(actor, number), processing: false };
  }

  /** Run periodically; each pass is bounded so routine maintenance cannot monopolize the DB. */
  async cleanup(): Promise<{
    recovered: number;
    purgedReports: number;
    deleted: number;
  }> {
    const now = new Date();
    const interrupted = await this.prisma.importJob.findMany({
      where: { status: 'PROCESSING', attemptExpiresAt: { lt: now } },
      select: { number: true },
      take: 100,
    });
    for (const { number } of interrupted) await this.recover(number);
    await this.expirePreview();
    const purgedReports = await this.prisma.importJob.updateMany({
      where: { errorsExpiresAt: { lt: now }, errors: { not: Prisma.DbNull } },
      data: { errors: Prisma.DbNull },
    });
    const old = await this.prisma.importJob.findMany({
      where: { retainUntil: { lt: now }, status: { not: 'PROCESSING' } },
      select: { id: true },
      take: 1000,
    });
    const deleted = old.length
      ? await this.prisma.importJob.deleteMany({
          where: {
            id: { in: old.map((job) => job.id) },
            status: { not: 'PROCESSING' },
          },
        })
      : { count: 0 };
    return {
      recovered: interrupted.length,
      purgedReports: purgedReports.count,
      deleted: deleted.count,
    };
  }
}
