import { stringify } from 'csv-stringify/sync';
import { PRODUCT_IMPORT_COLUMNS } from './import.constants';
import type { RowIssue } from './import.types';

export function productTemplateCsv(): string {
  return `\uFEFF${stringify([PRODUCT_IMPORT_COLUMNS])}`;
}

export function errorReportCsv(issues: RowIssue[]): string {
  return `\uFEFF${stringify(
    [
      ['rowNumber', 'field', 'code', 'message'],
      ...issues.map(({ rowNumber, field, code, message }) => [
        rowNumber,
        field,
        code,
        message,
      ]),
    ],
    { escape_formulas: true },
  )}`;
}
