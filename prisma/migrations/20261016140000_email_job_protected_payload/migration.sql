-- AlterTable
ALTER TABLE "EmailJob" ADD COLUMN     "protectedPayload" TEXT;


-- Prisma does not model the constraint below; it neither manages nor drops it.

-- Sealed secrets (a link token) live only as long as the job may still be
-- sent: a job that was sent, failed or was cancelled holds none.
ALTER TABLE "EmailJob" ADD CONSTRAINT "EmailJob_payload_cleared_check" CHECK (
  "status" = 'PENDING' OR "protectedPayload" IS NULL
);
