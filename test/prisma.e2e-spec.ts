import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { validate } from '../src/config/env.validation';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('PrismaService (e2e)', () => {
  let prisma: PrismaService;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, validate }),
        PrismaModule,
      ],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    close = () => moduleRef.close();
  });

  afterAll(async () => {
    await close();
  });

  it('connects to the test database', async () => {
    const rows = await prisma.$queryRaw<
      { db: string }[]
    >`SELECT current_database() AS db`;
    expect(rows[0].db).toMatch(/_test$/);
  });

  it('has the migrated User table', async () => {
    await expect(prisma.user.count()).resolves.toEqual(expect.any(Number));
  });
});
