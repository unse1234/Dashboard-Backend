import { errorReportCsv, productTemplateCsv } from './import-report';

describe('productTemplateCsv', () => {
  it('is a BOM-prefixed header row with every column and no data', () => {
    const template = productTemplateCsv();

    expect(template.startsWith('﻿')).toBe(true);
    expect(template.trimEnd().split('\n')).toEqual([
      '﻿name,sku,category,price,costPrice,stock,status,brand,description',
    ]);
  });
});

describe('errorReportCsv', () => {
  it('lists only row numbers and server-written text', () => {
    const report = errorReportCsv([
      {
        rowNumber: 3,
        field: 'price',
        code: 'INVALID_MONEY',
        message: 'Use an amount from 0 to 1000000 with at most two decimals.',
      },
    ]);

    expect(report.trimEnd().split('\n')).toEqual([
      '﻿rowNumber,field,code,message',
      '3,price,INVALID_MONEY,Use an amount from 0 to 1000000 with at most two decimals.',
    ]);
  });

  it('is header-only when there is nothing to report', () => {
    expect(errorReportCsv([]).trimEnd()).toBe('﻿rowNumber,field,code,message');
  });

  it('quotes commas and neutralizes spreadsheet formulas', () => {
    const report = errorReportCsv([
      {
        rowNumber: 2,
        field: 'name',
        code: 'X',
        message: '=HYPERLINK("http://x"),y',
      },
    ]);

    const row = report.trimEnd().split('\n')[1];
    // csv-stringify prefixes a quote so a spreadsheet reads the cell as text.
    expect(row).toContain("'=HYPERLINK");
    expect(row.startsWith('2,name,X,"')).toBe(true);
  });
});
