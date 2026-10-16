import { IsOptional, IsString, Matches } from 'class-validator';

export class UploadProductImagesQueryDto {
  /** Replace one existing slot, linking the new file before removing the old. */
  @IsOptional()
  @IsString()
  @Matches(
    /^(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|ext-[0-9a-f]{64})$/,
  )
  replaceImageId?: string;
}
