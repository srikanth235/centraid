// Password-manager CSV parsing (issue #293 phase 2 of the sealed class):
// the common export shapes — Chrome/1Password (`name,url,username,password`)
// and Bitwarden (`login_uri,login_username,login_password,login_totp`) —
// via header aliases, same discipline as the bank-statement parser. A CSV
// routes here (not to transactions) when its header names a password column;
// the staged rows' secret fields seal in the draft band immediately.

import { parseCsvRows } from './csv.js';

export interface CsvPasswordItem {
  title: string;
  url: string | null;
  username: string | null;
  password: string | null;
  otpSeed: string | null;
  notes: string | null;
}

const TITLE_ALIASES = ['name', 'title', 'item'];
const URL_ALIASES = ['url', 'login_uri', 'website', 'uri'];
const USERNAME_ALIASES = ['username', 'login_username', 'user', 'login'];
const PASSWORD_ALIASES = ['password', 'login_password', 'pass'];
const OTP_ALIASES = ['otp', 'totp', 'login_totp', 'otp_seed', 'otpauth'];
const NOTES_ALIASES = ['notes', 'note', 'comments'];

function findColumn(header: string[], aliases: string[]): number {
  const lower = header.map((h) => h.trim().toLowerCase());
  for (const alias of aliases) {
    const i = lower.indexOf(alias);
    if (i >= 0) return i;
  }
  return -1;
}

/** Does this CSV header look like a password-manager export? */
export function isPasswordsCsvHeader(header: string[]): boolean {
  return (
    findColumn(header, PASSWORD_ALIASES) >= 0 &&
    (findColumn(header, USERNAME_ALIASES) >= 0 || findColumn(header, URL_ALIASES) >= 0)
  );
}

/**
 * A bare `otpauth://` URI hides the seed in its `secret` param — extract it;
 * a plain base32 seed passes through.
 */
function otpSeedOf(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith('otpauth://')) return raw;
  try {
    return new URL(raw).searchParams.get('secret');
  } catch {
    return null;
  }
}

/** Parse a password-manager CSV. Throws when the header does not match. */
export function parsePasswordsCsv(text: string): CsvPasswordItem[] {
  const rows = parseCsvRows(text);
  const header = rows[0];
  if (!header || !isPasswordsCsvHeader(header)) {
    throw new Error('csv header does not name a password column');
  }
  const col = {
    title: findColumn(header, TITLE_ALIASES),
    url: findColumn(header, URL_ALIASES),
    username: findColumn(header, USERNAME_ALIASES),
    password: findColumn(header, PASSWORD_ALIASES),
    otp: findColumn(header, OTP_ALIASES),
    notes: findColumn(header, NOTES_ALIASES),
  };
  const cell = (row: string[], i: number): string | null => {
    if (i < 0) return null;
    const v = row[i]?.trim();
    return v ? v : null;
  };
  const hostnameOf = (url: string): string | null => {
    try {
      return new URL(url.includes('://') ? url : `https://${url}`).hostname || null;
    } catch {
      return null;
    }
  };
  const items: CsvPasswordItem[] = [];
  for (const row of rows.slice(1)) {
    const url = cell(row, col.url);
    const username = cell(row, col.username);
    const title = cell(row, col.title) ?? (url ? hostnameOf(url) : null);
    if (!title) continue; // a row with no name and no url is unusable
    items.push({
      title,
      url,
      username,
      password: cell(row, col.password),
      otpSeed: otpSeedOf(cell(row, col.otp)),
      notes: cell(row, col.notes),
    });
  }
  return items;
}
