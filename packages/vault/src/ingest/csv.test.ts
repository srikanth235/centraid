// Bank-statement CSV parser unit tests (issue #545 B6).

import { describe, expect, test } from 'vitest';

import { parseCsvRows, parseTransactionsCsv } from './csv.js';

describe('csv', () => {
  test('parseCsvRows handles quoted fields, escaped quotes, and CRLF', () => {
    const text = ['a,b,c', '"hello, world","he said ""hi""",3', 'x,y,z'].join('\r\n');
    expect(parseCsvRows(text)).toStrictEqual([
      ['a', 'b', 'c'],
      ['hello, world', 'he said "hi"', '3'],
      ['x', 'y', 'z'],
    ]);
  });

  test('parseCsvRows skips blank lines', () => {
    expect(parseCsvRows('a,b\n\n\nc,d\n')).toStrictEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  test('parseTransactionsCsv maps signed amounts and ISO dates', () => {
    const text = [
      'Date,Description,Amount,Currency,Reference',
      '2026-07-01,Coffee,-4.50,USD,r1',
      '02/07/2026,Payroll,2500.00,USD,r2',
    ].join('\n');
    const rows = parseTransactionsCsv(text);
    expect(rows).toStrictEqual([
      {
        externalId: 'r1',
        postedAt: '2026-07-01T00:00:00Z',
        description: 'Coffee',
        amountMinor: 450,
        currency: 'USD',
        direction: 'debit',
      },
      {
        externalId: 'r2',
        postedAt: '2026-07-02T00:00:00Z',
        description: 'Payroll',
        amountMinor: 250_000,
        currency: 'USD',
        direction: 'credit',
      },
    ]);
  });

  test('parseTransactionsCsv accepts header aliases and strips currency symbols', () => {
    const text = ['Posted,Payee,Amount (INR),Id', '2026-01-15,Shop,"₹1,234.56",txn-9'].join('\n');
    const [row] = parseTransactionsCsv(text);
    expect(row).toMatchObject({
      externalId: 'txn-9',
      description: 'Shop',
      amountMinor: 123_456,
      direction: 'credit',
      currency: null,
    });
  });

  test('parseTransactionsCsv throws when header lacks date or amount', () => {
    expect(() => parseTransactionsCsv('foo,bar\n1,2\n')).toThrow(/date and an amount/u);
    expect(() => parseTransactionsCsv('Date,Amount\n')).toThrow(/no data rows/u);
  });

  test('parseTransactionsCsv skips unparseable noise rows', () => {
    const text = [
      'Date,Amount,Description',
      'not-a-date,10,x',
      '2026-01-01,n/a,y',
      '2026-01-02,5,z',
    ].join('\n');
    expect(parseTransactionsCsv(text)).toStrictEqual([
      {
        externalId: null,
        postedAt: '2026-01-02T00:00:00Z',
        description: 'z',
        amountMinor: 500,
        currency: null,
        direction: 'credit',
      },
    ]);
  });
});
