import type { ProductStatus } from '../generated/prisma/client';
import type { ProductImportColumn } from './import.constants';

export interface RowIssue {
  rowNumber: number;
  field: ProductImportColumn | 'file';
  code: string;
  message: string;
}

export interface ProductImportValues {
  name: string;
  sku: string;
  category: string;
  price: string;
  costPrice: string;
  stock: string;
  status: string;
  brand: string;
  description: string;
}

export interface ProductImportRow {
  rowNumber: number;
  values: ProductImportValues;
  categoryId: string | null;
  issues: RowIssue[];
}

export interface ImportPreviewPayload {
  mapping: Record<string, ProductImportColumn>;
  rows: ProductImportRow[];
}

export interface ValidProductRow {
  rowNumber: number;
  dto: {
    name: string;
    sku: string;
    categoryId: string;
    price: number;
    costPrice: number | null;
    stock: number;
    status: ProductStatus;
    brand: string | null;
    description: string | null;
  };
}
