import { Controller, Get } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';

export interface CategoryDto {
  id: string;
  name: string;
}

// The options of the product filter and form. Categories are reference data
// seeded by a migration; managing them is not part of this release.
@Roles('ADMIN', 'STAFF')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(): Promise<{ data: CategoryDto[] }> {
    const data = await this.prisma.category.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    return { data };
  }
}
