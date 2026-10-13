import {
  BadRequestException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { parseProductCsv } from './csv.parser';
import { IMPORT_MAX_FILE_BYTES, IMPORT_MAX_ROWS } from './import.constants';

const HEADER = 'name,sku,category,price';
const csv = (...lines: string[]) => Buffer.from(lines.join('\n'), 'utf8');
const parse = (bytes: Buffer, filename = 'products.csv', mime = 'text/csv') =>
  parseProductCsv(bytes, filename, mime);

describe('parseProductCsv', () => {
  describe('accepted files', () => {
    it('maps canonical headers and numbers records from the header row', async () => {
      const result = await parse(
        csv(HEADER, 'Mug,MUG-1,Home,10', 'Cup,CUP-1,Home,5'),
      );

      expect(result.mapping).toEqual({
        name: 'name',
        sku: 'sku',
        category: 'category',
        price: 'price',
      });
      expect(result.rows).toEqual([
        {
          rowNumber: 2,
          cells: { name: 'Mug', sku: 'MUG-1', category: 'Home', price: '10' },
        },
        {
          rowNumber: 3,
          cells: { name: 'Cup', sku: 'CUP-1', category: 'Home', price: '5' },
        },
      ]);
    });

    it('accepts a UTF-8 BOM, CRLF line ends and any column order', async () => {
      const bytes = Buffer.from(
        '﻿price,sku,name,category,stock\r\n9.5,S-1,Lamp,Home,3\r\n',
        'utf8',
      );

      const result = await parse(bytes);

      expect(result.rows).toEqual([
        {
          rowNumber: 2,
          cells: {
            price: '9.5',
            sku: 'S-1',
            name: 'Lamp',
            category: 'Home',
            stock: '3',
          },
        },
      ]);
    });

    it('resolves the documented aliases, ignoring case, spaces and underscores', async () => {
      const result = await parse(
        csv(
          'Product Name,sku,Category_Name,Selling Price,cost price,Stock_Quantity',
          'Mug,M-1,Home,10,4,7',
        ),
      );

      expect(Object.values(result.mapping).sort()).toEqual(
        ['category', 'costPrice', 'name', 'price', 'sku', 'stock'].sort(),
      );
      expect(result.rows[0].cells).toEqual({
        name: 'Mug',
        sku: 'M-1',
        category: 'Home',
        price: '10',
        costPrice: '4',
        stock: '7',
      });
    });

    it('keeps quoted commas, quotes and line breaks inside one record', async () => {
      const result = await parse(
        Buffer.from(
          `${HEADER},description\n"Mug, large",M-1,Home,10,"Says ""hi""\nsecond line"\nCup,C-1,Home,5,\n`,
        ),
      );

      expect(result.rows).toHaveLength(2);
      expect(result.rows[0].cells.name).toBe('Mug, large');
      expect(result.rows[0].cells.description).toBe('Says "hi"\nsecond line');
      // The multi-line record is a single row, so the next one is row 3.
      expect(result.rows[1].rowNumber).toBe(3);
    });

    it('keeps Unicode text intact', async () => {
      const result = await parse(csv(HEADER, 'Café ☕ Becher,ÄÖ-1,Küche,10'));

      expect(result.rows[0].cells.name).toBe('Café ☕ Becher');
      expect(result.rows[0].cells.category).toBe('Küche');
    });

    it('skips physically blank lines but keeps a record of empty cells', async () => {
      const result = await parse(
        csv(HEADER, '', 'Mug,M-1,Home,10', '', ',,,', ''),
      );

      expect(result.rows.map((row) => row.cells)).toEqual([
        { name: 'Mug', sku: 'M-1', category: 'Home', price: '10' },
        { name: '', sku: '', category: '', price: '' },
      ]);
    });

    it.each([
      'text/csv',
      'application/csv',
      'text/plain',
      'application/vnd.ms-excel',
      'application/octet-stream',
      '',
    ])('treats the declared type %j as a hint only', async (mime) => {
      await expect(
        parse(csv(HEADER, 'Mug,M-1,Home,10'), 'products.csv', mime),
      ).resolves.toBeDefined();
    });

    it('compares the extension case-insensitively', async () => {
      await expect(
        parse(csv(HEADER, 'Mug,M-1,Home,10'), 'PRODUCTS.CSV'),
      ).resolves.toBeDefined();
    });

    it('accepts exactly the record limit', async () => {
      const rows = Array.from(
        { length: IMPORT_MAX_ROWS },
        (_, index) => `P${index},S-${index},Home,1`,
      );

      const result = await parse(csv(HEADER, ...rows));

      expect(result.rows).toHaveLength(IMPORT_MAX_ROWS);
      expect(result.rows.at(-1)?.rowNumber).toBe(IMPORT_MAX_ROWS + 1);
    });
  });

  describe('rejected content', () => {
    it.each([
      ['an extra extension', 'products.csv.exe'],
      ['a spreadsheet extension', 'products.xlsx'],
      ['no extension', 'products'],
    ])('rejects %s', async (_label, filename) => {
      await expect(
        parse(csv(HEADER, 'Mug,M-1,Home,10'), filename),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    });

    it('rejects a declared type that is not on the allowlist', async () => {
      await expect(
        parse(csv(HEADER, 'Mug,M-1,Home,10'), 'products.csv', 'image/png'),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    });

    it('rejects an empty or whitespace-only file', async () => {
      await expect(parse(Buffer.alloc(0))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(parse(Buffer.from(' \n\n  \n'))).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects a header with no data rows', async () => {
      await expect(parse(csv(HEADER))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(parse(csv(HEADER, '', ''))).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it.each([
      [
        'a ZIP container (an .xlsx renamed to .csv)',
        Buffer.from('PK\u0003\u0004rest'),
      ],
      [
        'an OLE container (an .xls renamed to .csv)',
        Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3]),
      ],
      ['a file with NUL bytes (UTF-16)', Buffer.from('﻿name,sku\n', 'utf16le')],
    ])('rejects %s', async (_label, bytes) => {
      await expect(parse(bytes)).rejects.toBeInstanceOf(
        UnsupportedMediaTypeException,
      );
    });

    it('rejects bytes that are not valid UTF-8', async () => {
      const bytes = Buffer.concat([
        Buffer.from(`${HEADER}\nMug,M-1,Home,`),
        Buffer.from([0xff, 0xfe, 0xfd]),
      ]);

      await expect(parse(bytes)).rejects.toBeInstanceOf(
        UnsupportedMediaTypeException,
      );
    });

    it('rejects a file over the byte limit', async () => {
      const overLimit = Buffer.alloc(IMPORT_MAX_FILE_BYTES + 1, 'a');

      await expect(parse(overLimit)).rejects.toBeInstanceOf(
        PayloadTooLargeException,
      );
    });

    it('rejects one record over the row limit', async () => {
      const rows = Array.from(
        { length: IMPORT_MAX_ROWS + 1 },
        (_, index) => `P${index},S-${index},Home,1`,
      );

      await expect(parse(csv(HEADER, ...rows))).rejects.toBeInstanceOf(
        PayloadTooLargeException,
      );
    });
  });

  describe('rejected structure', () => {
    it('rejects a semicolon-delimited file instead of guessing', async () => {
      await expect(
        parse(csv('name;sku;category;price', 'Mug;M-1;Home;10')),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it.each([
      ['an unknown header', 'name,sku,category,price,colour'],
      ['a protected header', 'name,sku,category,price,id'],
      ['a database field name', 'name,sku,categoryId,price'],
      ['a prototype key', 'name,sku,category,price,__proto__'],
    ])('rejects %s', async (_label, header) => {
      await expect(
        parse(csv(header, 'Mug,M-1,Home,10,x')),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it.each([
      ['a repeated header', 'name,sku,category,price,price'],
      [
        'an alias colliding with its canonical header',
        'name,sku,category,price,Selling Price',
      ],
    ])('rejects %s', async (_label, header) => {
      await expect(
        parse(csv(header, 'Mug,M-1,Home,10,10')),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it.each([['name'], ['sku'], ['category'], ['price']])(
      'requires the %s column',
      async (missing) => {
        const columns = ['name', 'sku', 'category', 'price'].filter(
          (column) => column !== missing,
        );

        await expect(
          parse(csv(columns.join(','), columns.map(() => 'x').join(','))),
        ).rejects.toBeInstanceOf(BadRequestException);
      },
    );

    it('rejects an empty header cell and an over-long header', async () => {
      await expect(
        parse(csv(`${HEADER},`, 'Mug,M-1,Home,10,')),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        parse(csv(`${HEADER},${'x'.repeat(65)}`, 'Mug,M-1,Home,10,1')),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects more columns than the template has', async () => {
      const header =
        'name,sku,category,price,costPrice,stock,status,brand,description,extra';

      await expect(parse(csv(header, 'a,b,c,1,,,,,,'))).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it.each([
      ['too few fields', 'Mug,M-1,Home'],
      ['too many fields', 'Mug,M-1,Home,10,extra'],
    ])('rejects a record with %s', async (_label, row) => {
      await expect(parse(csv(HEADER, row))).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects an unterminated quote instead of skipping the record', async () => {
      await expect(
        parse(csv(HEADER, '"Mug,M-1,Home,10')),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a record larger than the parser buffer', async () => {
      const huge = 'x'.repeat(40 * 1024);

      await expect(
        parse(csv(`${HEADER},description`, `Mug,M-1,Home,10,"${huge}"`)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
