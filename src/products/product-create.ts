import { BadRequestException } from '@nestjs/common';
import type { AuthenticatedUser } from '../common/authenticated-user';
import { toDecimal } from '../common/money';
import { SHOP_CURRENCY } from '../common/currency';
import type { Prisma } from '../generated/prisma/client';
import type { Db } from '../prisma/prisma.service';
import type { CreateProductDto } from './dto/create-product.dto';
import { toEventRows } from './product-events';
import { productSelect } from './product.mapper';

export function productCreateData(
  dto: CreateProductDto,
): Prisma.ProductCreateManyInput {
  if (dto.currency !== undefined && dto.currency !== SHOP_CURRENCY) {
    throw new BadRequestException('currency must be PKR');
  }
  return {
    name: dto.name,
    sku: dto.sku,
    subtitle: dto.subtitle ?? null,
    brand: dto.brand ?? null,
    description: dto.description ?? null,
    imageUrl: dto.imageUrl ?? null,
    galleryUrls: dto.galleryUrls ?? [],
    categoryId: dto.categoryId,
    status: dto.status ?? 'ACTIVE',
    price: toDecimal(dto.price),
    currency: SHOP_CURRENCY,
    costPrice: dto.costPrice == null ? null : toDecimal(dto.costPrice),
    stock: dto.stock ?? 0,
  };
}

export async function assertCategoriesExist(
  db: Db,
  categoryIds: string[],
): Promise<void> {
  const ids = [...new Set(categoryIds)];
  const count = await db.category.count({ where: { id: { in: ids } } });
  if (count !== ids.length) throw new BadRequestException('Unknown category');
}

export async function createProductInTransaction(
  db: Db,
  actor: AuthenticatedUser,
  dto: CreateProductDto,
) {
  await assertCategoriesExist(db, [dto.categoryId]);
  const created = await db.product.create({
    data: productCreateData(dto),
    select: productSelect,
  });
  await db.productEvent.createMany({
    data: toEventRows(created.id, actor.id, [{ type: 'CREATED', data: {} }]),
  });
  return created;
}

/** All chunks share the caller's transaction. Returning numbers enables a bounded audit trail. */
export async function createProductsInTransaction(
  db: Db,
  actor: AuthenticatedUser,
  dtos: CreateProductDto[],
): Promise<number[]> {
  await assertCategoriesExist(
    db,
    dtos.map((dto) => dto.categoryId),
  );
  const numbers: number[] = [];
  for (let offset = 0; offset < dtos.length; offset += 100) {
    const products = await db.product.createManyAndReturn({
      data: dtos.slice(offset, offset + 100).map(productCreateData),
      select: { id: true, number: true },
    });
    await db.productEvent.createMany({
      data: products.flatMap(({ id }) =>
        toEventRows(id, actor.id, [{ type: 'CREATED', data: {} }]),
      ),
    });
    numbers.push(...products.map((product) => product.number));
  }
  return numbers;
}
