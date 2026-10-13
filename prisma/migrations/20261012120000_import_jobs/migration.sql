CREATE TYPE "ImportType" AS ENUM ('PRODUCTS');
CREATE TYPE "ImportJobStatus" AS ENUM ('READY', 'VALIDATION_FAILED', 'PROCESSING', 'COMPLETED', 'FAILED', 'EXPIRED');

CREATE TABLE "ImportJob" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "type" "ImportType" NOT NULL DEFAULT 'PRODUCTS',
    "status" "ImportJobStatus" NOT NULL,
    "initiatedById" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL,
    "fileSha256" TEXT NOT NULL,
    "clientRequestId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "previewHash" TEXT NOT NULL,
    "totalRows" INTEGER NOT NULL,
    "validRows" INTEGER NOT NULL,
    "invalidRows" INTEGER NOT NULL,
    "importedRows" INTEGER NOT NULL DEFAULT 0,
    "createdProductNumbers" JSONB,
    "previewPayload" JSONB,
    "errors" JSONB,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "attemptToken" TEXT,
    "attemptExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "previewExpiresAt" TIMESTAMP(3) NOT NULL,
    "errorsExpiresAt" TIMESTAMP(3) NOT NULL,
    "retainUntil" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ImportJob_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ImportJob_counts_check" CHECK (
      "totalRows" BETWEEN 1 AND 250 AND "validRows" >= 0 AND "invalidRows" >= 0
      AND "totalRows" = "validRows" + "invalidRows"
      AND "importedRows" IN (0, "totalRows")
      AND (("status" = 'COMPLETED' AND "importedRows" = "totalRows")
        OR ("status" <> 'COMPLETED' AND "importedRows" = 0)))
);

CREATE UNIQUE INDEX "ImportJob_number_key" ON "ImportJob"("number");
CREATE UNIQUE INDEX "ImportJob_initiatedById_clientRequestId_key" ON "ImportJob"("initiatedById", "clientRequestId");
CREATE INDEX "ImportJob_initiatedById_createdAt_number_idx" ON "ImportJob"("initiatedById", "createdAt" DESC, "number" DESC);
CREATE INDEX "ImportJob_status_createdAt_number_idx" ON "ImportJob"("status", "createdAt" DESC, "number" DESC);
CREATE INDEX "ImportJob_createdAt_number_idx" ON "ImportJob"("createdAt" DESC, "number" DESC);
CREATE INDEX "ImportJob_previewExpiresAt_idx" ON "ImportJob"("previewExpiresAt");
CREATE INDEX "ImportJob_errorsExpiresAt_idx" ON "ImportJob"("errorsExpiresAt");
CREATE INDEX "ImportJob_retainUntil_idx" ON "ImportJob"("retainUntil");
CREATE INDEX "ImportJob_status_attemptExpiresAt_idx" ON "ImportJob"("status", "attemptExpiresAt");
ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_initiatedById_fkey" FOREIGN KEY ("initiatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
