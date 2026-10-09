import { ValidationPipe } from '@nestjs/common';
import { ListCustomersQueryDto } from './list-customers-query.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const run = (value: unknown) =>
  pipe.transform(value, { type: 'query', metatype: ListCustomersQueryDto });

describe('ListCustomersQueryDto', () => {
  it('defaults to the first page of 20, ascending when a sort is given', async () => {
    await expect(run({})).resolves.toEqual({
      page: 1,
      pageSize: 20,
      sortOrder: 'asc',
    });
  });

  it('converts query strings and trims the search', async () => {
    await expect(
      run({
        page: '3',
        pageSize: '100',
        search: '  ada  ',
        sortBy: 'totalSpent',
        sortOrder: 'desc',
      }),
    ).resolves.toEqual({
      page: 3,
      pageSize: 100,
      search: 'ada',
      sortBy: 'totalSpent',
      sortOrder: 'desc',
    });
  });

  it.each(['id', 'name', 'email', 'totalOrders', 'totalSpent', 'joinedAt'])(
    'accepts sortBy=%s',
    async (sortBy) => {
      await expect(run({ sortBy })).resolves.toMatchObject({ sortBy });
    },
  );

  it.each([
    ['page 0', { page: '0' }],
    ['a fractional page', { page: '1.5' }],
    ['a non-numeric page', { page: 'two' }],
    ['pageSize 0', { pageSize: '0' }],
    ['pageSize over 100', { pageSize: '101' }],
    ['a search over 100 characters', { search: 'a'.repeat(101) }],
    ['an unknown sort column', { sortBy: 'phone' }],
    ['a sort column in the wrong case', { sortBy: 'Name' }],
    ['an unknown sort order', { sortOrder: 'up' }],
    ['an unknown parameter', { status: 'active' }],
  ])('rejects %s', async (_label, query) => {
    await expect(run(query)).rejects.toMatchObject({ status: 400 });
  });

  it('measures the search length after trimming', async () => {
    await expect(
      run({ search: `  ${'a'.repeat(100)}  ` }),
    ).resolves.toMatchObject({ search: 'a'.repeat(100) });
  });
});
