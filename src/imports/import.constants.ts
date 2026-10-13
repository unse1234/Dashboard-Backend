export const IMPORT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 250;
export const IMPORT_MAX_PREVIEW_BYTES = 4 * 1024 * 1024;
export const IMPORT_MAX_ERRORS_BYTES = 1024 * 1024;
export const IMPORT_SCHEMA_VERSION = 1;
export const PREVIEW_TTL_MS = 15 * 60_000;
export const ERRORS_TTL_MS = 7 * 24 * 60 * 60_000;
export const HISTORY_TTL_MS = 90 * 24 * 60 * 60_000;
export const IMPORT_LOCK_NAMESPACE = 0x494d50;

export const PRODUCT_IMPORT_COLUMNS = [
  'name',
  'sku',
  'category',
  'price',
  'costPrice',
  'stock',
  'status',
  'brand',
  'description',
] as const;
export type ProductImportColumn = (typeof PRODUCT_IMPORT_COLUMNS)[number];

export const REQUIRED_PRODUCT_COLUMNS: readonly ProductImportColumn[] = [
  'name',
  'sku',
  'category',
  'price',
];
