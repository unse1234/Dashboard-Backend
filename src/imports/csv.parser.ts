import {
  BadRequestException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { Readable } from 'node:stream';
import { parse } from 'csv-parse';
import {
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_ROWS,
  PRODUCT_IMPORT_COLUMNS,
  REQUIRED_PRODUCT_COLUMNS,
  type ProductImportColumn,
} from './import.constants';

const COLUMN_BY_NORMALIZED = new Map<string, ProductImportColumn>(
  PRODUCT_IMPORT_COLUMNS.map((column) => [normalizeHeader(column), column]),
);
for (const [alias, canonical] of [
  ['productname', 'name'],
  ['sellingprice', 'price'],
  ['costprice', 'costPrice'],
  ['stockquantity', 'stock'],
  ['categoryname', 'category'],
] as const)
  COLUMN_BY_NORMALIZED.set(alias, canonical);

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]/g, '');
}

export interface ParsedProductCsv {
  mapping: Record<string, ProductImportColumn>;
  rows: {
    rowNumber: number;
    cells: Partial<Record<ProductImportColumn, string>>;
  }[];
}

/** Parse into arrays first so duplicate headers cannot silently overwrite fields. */
export async function parseProductCsv(
  bytes: Buffer,
  filename: string,
  mime: string,
): Promise<ParsedProductCsv> {
  if (!filename.toLowerCase().endsWith('.csv')) {
    throw new UnsupportedMediaTypeException('Choose a .csv file.');
  }
  if (
    ![
      'text/csv',
      'application/csv',
      'text/plain',
      'application/vnd.ms-excel',
      'application/octet-stream',
      '',
    ].includes(mime)
  ) {
    throw new UnsupportedMediaTypeException('Unsupported CSV content type.');
  }
  if (bytes.length === 0)
    throw new BadRequestException('The CSV file is empty.');
  if (bytes.length > IMPORT_MAX_FILE_BYTES) {
    throw new PayloadTooLargeException('The CSV file exceeds 10 MiB.');
  }
  if (
    bytes.includes(0) ||
    bytes.subarray(0, 2).equals(Buffer.from('PK')) ||
    bytes.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))
  ) {
    throw new UnsupportedMediaTypeException('Save the file as CSV UTF-8.');
  }

  let contents: string;
  try {
    contents = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new UnsupportedMediaTypeException('Save the file as CSV UTF-8.');
  }
  if (!contents.trim()) throw new BadRequestException('The CSV file is empty.');

  const parser = Readable.from([contents]).pipe(
    parse({
      bom: true,
      delimiter: ',',
      columns: false,
      cast: false,
      info: true,
      skip_empty_lines: true,
      relax_column_count: false,
      max_record_size: 32 * 1024,
    }),
  );
  let headers: string[] | null = null;
  let columns: ProductImportColumn[] = [];
  const mapping: Record<string, ProductImportColumn> = {};
  const rows: ParsedProductCsv['rows'] = [];
  try {
    for await (const item of parser) {
      const cells = (item as { record: string[] }).record;
      if (!headers) {
        headers = cells;
        if (
          headers.length === 0 ||
          headers.length > PRODUCT_IMPORT_COLUMNS.length
        ) {
          throw new BadRequestException(
            'The CSV needs supported product headers.',
          );
        }
        const seen = new Set<ProductImportColumn>();
        columns = headers.map((header) => {
          if (!header.trim() || header.length > 64) {
            throw new BadRequestException('A CSV header is empty or too long.');
          }
          const column = COLUMN_BY_NORMALIZED.get(normalizeHeader(header));
          if (!column)
            throw new BadRequestException(
              `Unsupported header: ${header.slice(0, 64)}.`,
            );
          if (seen.has(column))
            throw new BadRequestException(`Duplicate header: ${column}.`);
          seen.add(column);
          mapping[header] = column;
          return column;
        });
        for (const required of REQUIRED_PRODUCT_COLUMNS) {
          if (!seen.has(required))
            throw new BadRequestException(
              `Required header missing: ${required}.`,
            );
        }
        continue;
      }
      if (cells.length !== columns.length)
        throw new BadRequestException(
          'A CSV row has the wrong number of columns.',
        );
      if (rows.length >= IMPORT_MAX_ROWS) {
        throw new PayloadTooLargeException(
          'A CSV can contain at most 250 product rows.',
        );
      }
      const fields: Partial<Record<ProductImportColumn, string>> = {};
      cells.forEach((cell, index) => {
        fields[columns[index]] = cell;
      });
      rows.push({ rowNumber: rows.length + 2, cells: fields });
    }
  } catch (error) {
    parser.destroy();
    if (
      error instanceof BadRequestException ||
      error instanceof PayloadTooLargeException
    )
      throw error;
    throw new BadRequestException(
      'Malformed CSV. Check quotes, delimiters, and row lengths.',
    );
  }
  if (!headers || rows.length === 0)
    throw new BadRequestException(
      'The CSV needs a header and at least one product row.',
    );
  return { mapping, rows };
}
