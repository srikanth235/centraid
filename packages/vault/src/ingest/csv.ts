// Bank-statement CSV parsing (issue #290 phase 2). Deliberately narrow: a
// header row naming a date, a description and an amount column (aliases
// below), optional currency and id columns. Signed amounts: negative = debit.
// Two-decimal minor units — the common case for consumer statements; exotic
// scales ride a real connector later.

export interface CsvTransaction {
  externalId: string | null;
  postedAt: string;
  description: string | null;
  amountMinor: number;
  currency: string | null;
  direction: 'debit' | 'credit';
}

const DATE_ALIASES = ['date', 'posted_at', 'posted', 'transaction date', 'value date'];
const DESC_ALIASES = ['description', 'memo', 'payee', 'narration', 'details'];
const AMOUNT_ALIASES = ['amount', 'value', 'amount (inr)', 'amount (usd)'];
const CURRENCY_ALIASES = ['currency', 'ccy'];
const ID_ALIASES = ['id', 'external_id', 'reference', 'ref', 'transaction id'];

/** RFC 4180-ish row splitter: quoted fields, escaped quotes, CRLF-tolerant. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

function findColumn(header: string[], aliases: string[]): number {
  const lower = header.map((h) => h.trim().toLowerCase());
  for (const alias of aliases) {
    const i = lower.indexOf(alias);
    if (i >= 0) return i;
  }
  return -1;
}

function isoDay(raw: string): string | null {
  const t = raw.trim();
  // ISO first; then dd/mm/yyyy and mm/dd/yyyy are ambiguous — accept
  // dd/mm/yyyy (statement convention outside the US) and yyyy-mm-dd.
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const dmy = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`;
  }
  const parsed = Date.parse(t);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
}

/**
 * Parse a statement CSV. Throws when the header names no usable columns —
 * a misread statement must fail loudly, not import garbage.
 */
export function parseTransactionsCsv(text: string): CsvTransaction[] {
  const rows = parseCsvRows(text);
  if (rows.length < 2) throw new Error('CSV has no data rows');
  const header = rows[0]!;
  const dateCol = findColumn(header, DATE_ALIASES);
  const descCol = findColumn(header, DESC_ALIASES);
  const amountCol = findColumn(header, AMOUNT_ALIASES);
  if (dateCol < 0 || amountCol < 0) {
    throw new Error(`CSV header must name a date and an amount column (got: ${header.join(', ')})`);
  }
  const currencyCol = findColumn(header, CURRENCY_ALIASES);
  const idCol = findColumn(header, ID_ALIASES);

  const out: CsvTransaction[] = [];
  for (const row of rows.slice(1)) {
    const day = isoDay(row[dateCol] ?? '');
    const rawAmount = (row[amountCol] ?? '').replace(/[,\s₹$€£]/g, '');
    const amount = Number.parseFloat(rawAmount);
    if (!day || Number.isNaN(amount)) continue; // ledger noise lines
    out.push({
      externalId: idCol >= 0 && row[idCol]?.trim() ? row[idCol]!.trim() : null,
      postedAt: `${day}T00:00:00Z`,
      description: descCol >= 0 ? (row[descCol]?.trim() ?? null) : null,
      amountMinor: Math.round(Math.abs(amount) * 100),
      currency: currencyCol >= 0 ? (row[currencyCol]?.trim().toUpperCase() ?? null) : null,
      direction: amount < 0 ? 'debit' : 'credit',
    });
  }
  return out;
}
