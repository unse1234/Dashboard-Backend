import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { AuthenticatedUser } from '../common/authenticated-user';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { IMPORT_MAX_FILE_BYTES } from './import.constants';
import { ConfirmImportDto } from './dto/confirm-import.dto';
import { ImportPageQueryDto } from './dto/import-page-query.dto';
import { ListImportsQueryDto } from './dto/list-imports-query.dto';
import { PreviewImportDto } from './dto/preview-import.dto';
import { ImportNumberParam } from './import-id.param';
import { errorReportCsv, productTemplateCsv } from './import-report';
import { ImportUploadGuard } from './import-upload.guard';
import { ImportsService } from './imports.service';
import { NoStoreInterceptor } from './no-store.interceptor';

@Roles('ADMIN', 'STAFF')
@UseInterceptors(NoStoreInterceptor)
@Controller('imports')
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @Get('types')
  types() {
    return this.imports.types();
  }

  @Get('templates/products')
  template(@Res() response: Response) {
    response.type('text/csv; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      'attachment; filename="products-import-v1.csv"',
    );
    response.send(productTemplateCsv());
  }

  @Post('preview')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UseGuards(ImportUploadGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        fileSize: IMPORT_MAX_FILE_BYTES,
        files: 1,
        fields: 2,
        parts: 3,
        fieldSize: 128,
        fieldNameSize: 32,
      },
    }),
  )
  async preview(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() input: PreviewImportDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { replayed, result } = await this.imports.preview(actor, input, file);
    // A lost response is replayed, not created again: 200 rather than 201.
    if (replayed) response.status(HttpStatus.OK);
    return result;
  }

  @Get()
  list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: ListImportsQueryDto,
  ) {
    return this.imports.list(actor, query);
  }

  @Get(':jobId/preview')
  previewPage(
    @CurrentUser() actor: AuthenticatedUser,
    @ImportNumberParam() number: number,
    @Query() query: ImportPageQueryDto,
  ) {
    return this.imports.getPreview(actor, number, query.page, query.pageSize);
  }

  @Get(':jobId/errors')
  async errors(
    @CurrentUser() actor: AuthenticatedUser,
    @ImportNumberParam() number: number,
    @Query() query: ImportPageQueryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (query.format === 'csv') {
      const issues = await this.imports.allErrors(actor, number);
      response.type('text/csv; charset=utf-8');
      response.setHeader(
        'Content-Disposition',
        `attachment; filename="import-${number}-errors.csv"`,
      );
      return errorReportCsv(issues);
    }
    return this.imports.getErrors(actor, number, query.page, query.pageSize);
  }

  @Get(':jobId')
  get(
    @CurrentUser() actor: AuthenticatedUser,
    @ImportNumberParam() number: number,
  ) {
    return this.imports.get(actor, number);
  }

  @Post(':jobId/confirm')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async confirm(
    @CurrentUser() actor: AuthenticatedUser,
    @ImportNumberParam() number: number,
    @Body() input: ConfirmImportDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.imports.confirm(actor, number, input);
    if (result.processing) response.status(HttpStatus.ACCEPTED);
    return result;
  }
}
