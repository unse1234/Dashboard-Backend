import type { Db } from '../prisma/prisma.service';

export interface GuestContact {
  name: string;
  /** Already trimmed and lower-cased by the request's validation. */
  email: string;
  phone: string;
}

/**
 * The customer a guest order belongs to, found or created by email. Customer
 * matching is bookkeeping, not authentication: nothing about an existing
 * customer is changed (name, phone and saved addresses stay as they are) and
 * nothing about them is returned to the guest.
 *
 * It runs inside the order's transaction, so a customer exists exactly when the
 * order does. Two first purchases with the same email at once cannot create two
 * customers: the loser's INSERT waits for the winner's transaction and then does
 * nothing, and its next read sees the winner's row.
 *
 * Match by email only, never by name or phone, and only by case. The exact
 * lookup uses the unique index; the case-insensitive one exists for rows that
 * were written before emails were lower-cased, and is reached only when the
 * exact one finds nothing. Legacy duplicates are never merged here.
 */
export async function resolveGuestCustomer(
  db: Db,
  contact: GuestContact,
): Promise<{ id: string }> {
  const find = async (): Promise<{ id: string } | undefined> => {
    const exact = await db.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Customer" WHERE "email" = ${contact.email} LIMIT 1`;
    if (exact[0]) return exact[0];
    const folded = await db.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Customer"
      WHERE lower("email") = ${contact.email}
      ORDER BY "createdAt" ASC, "id" ASC
      LIMIT 1`;
    return folded[0];
  };

  const existing = await find();
  if (existing) return existing;

  // The ids and timestamps Prisma would fill in client-side are written here.
  await db.$executeRaw`
    INSERT INTO "Customer" ("id", "name", "email", "phone", "createdAt", "updatedAt")
    VALUES (gen_random_uuid()::text, ${contact.name}, ${contact.email},
            ${contact.phone}, (now() AT TIME ZONE 'UTC'),
            (now() AT TIME ZONE 'UTC'))
    ON CONFLICT ("email") DO NOTHING`;

  const created = await find();
  if (!created) {
    // Only possible if the row was deleted between the two statements.
    throw new Error('The customer could not be resolved');
  }
  return created;
}
