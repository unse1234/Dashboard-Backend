import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
} from 'class-validator';
import { IsPublicId } from '../../common/validators/public-id.decorator';

export const MAX_ARCHIVE_BATCH = 100;

export class ArchiveProductsDto {
  /** Public ids such as "PRD-1001". */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ARCHIVE_BATCH)
  @ArrayUnique()
  @IsPublicId('PRD', { each: true })
  productIds!: string[];
}
