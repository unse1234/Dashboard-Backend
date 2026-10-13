import { IsEnum, IsUUID } from 'class-validator';
import { ImportType } from '../../generated/prisma/client';

export class PreviewImportDto {
  @IsEnum(ImportType)
  type!: ImportType;

  @IsUUID()
  clientRequestId!: string;
}
