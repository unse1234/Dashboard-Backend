import { Module } from '@nestjs/common';
import { ImportUploadGuard } from './import-upload.guard';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';

@Module({
  controllers: [ImportsController],
  providers: [ImportsService, ImportUploadGuard],
})
export class ImportsModule {}
