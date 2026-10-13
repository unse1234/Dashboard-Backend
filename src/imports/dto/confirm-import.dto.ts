import { IsInt, Matches, Equals } from 'class-validator';

export class ConfirmImportDto {
  @IsInt()
  @Equals(1)
  schemaVersion!: number;

  @Matches(/^[a-f0-9]{64}$/)
  previewHash!: string;
}
