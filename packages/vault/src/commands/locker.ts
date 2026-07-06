// governance: allow-repo-hygiene file-size-limit one command pack per domain is the vault contract (registered as a unit, read wholesale); Locker owns the whole password-manager write surface — add/edit/trash/restore/purge plus the canonical star — so it is one file by design.
// Locker commands (schema `locker`): the password-manager write surface.
// An item is one locker_item row — a login, card, secure note, identity,
// Wi-Fi or standalone password — with the type's fields and its free-form
// tags. add_item mints it; edit_item rewrites the type's fields and tags;
// trash_item soft-deletes with a ~30-day purge date (keeping the star, like
// Docs) and restore_item brings it back; purge_item is the one destructive,
// confirmation-gated command that erases the row for good.
//
// Favorites are NOT a column: star_item/unstar_item write the shared
// flags-scheme star on the item (issue #274) — the same mechanism Docs and
// Photos use — through setStarred. Every write is a typed command, consent-
// checked and receipted; only purge carries elevated risk.
//
// Secret handling (issue #293): password, otp_seed, card_number, cvv and
// content are SEALED columns — the execution pipeline seals them inside the
// write transaction, default reads show a placeholder, and plaintext takes
// the `reveal` verb. This pack's own derivative commands (`totp_code`,
// `watchtower`) decrypt via declared `unseals` and return only derivatives:
// the seed never crosses the command boundary, and every unseal is receipted.
// Secret-bearing inputs are declared `sealedInput`, so the append-only
// journal records keyed hash tokens, never values.

import { createHmac } from 'node:crypto';
import type { Gateway } from '../gateway/gateway.js';
import { SEALED_PLACEHOLDER } from '../schema/sealed.js';
import type { CommandDefinition, HandlerCtx } from '../gateway/types.js';
import { setStarred } from './flags.js';

export const LOCKER_ITEM_TYPE = 'locker.item';

const PURGE_WINDOW_DAYS = 30;

/** Columns each item type owns; everything else is nulled on write. */
const TYPE_FIELDS: Record<string, readonly string[]> = {
  login: ['username', 'password', 'url', 'otp_seed', 'notes'],
  card: ['cardholder', 'card_number', 'expiry', 'cvv', 'brand'],
  note: ['content'],
  identity: ['fullname', 'email', 'phone', 'address'],
  wifi: ['network', 'password'],
  password: ['password'],
};

const ALL_FIELDS = [
  'username',
  'password',
  'url',
  'otp_seed',
  'notes',
  'cardholder',
  'card_number',
  'expiry',
  'cvv',
  'brand',
  'content',
  'fullname',
  'email',
  'phone',
  'address',
  'network',
] as const;

/**
 * Input keys carrying secret material (issue #293): the journal records a
 * keyed hash token at these paths, never the value. Mirrors the sealed
 * columns of `locker.item` in the schema registry.
 */
const SEALED_INPUT = ['password', 'otp_seed', 'card_number', 'cvv', 'content'] as const;

const ITEM_EXISTS_SQL = 'SELECT count(*) AS n FROM locker_item WHERE item_id = :item_id';
const ITEM_LIVE_SQL =
  'SELECT count(*) AS n FROM locker_item WHERE item_id = :item_id AND deleted_at IS NULL';
const ITEM_TRASHED_SQL =
  'SELECT count(*) AS n FROM locker_item WHERE item_id = :item_id AND deleted_at IS NOT NULL';

/** An ISO instant `days` ahead of ctx.now, for the purge date. */
function plusDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

/** Replace an item's tags with the given set (deduped, trimmed, non-empty). */
function setTags(ctx: HandlerCtx, itemId: string, tags: readonly string[]): void {
  ctx.db.prepare('DELETE FROM locker_item_tag WHERE item_id = ?').run(itemId);
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = String(raw).trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    ctx.db.prepare('INSERT INTO locker_item_tag (item_id, tag) VALUES (?, ?)').run(itemId, tag);
  }
}

/** The subset of `input` that is a real column for `type`, as column→value. */
function fieldValues(type: string, input: Record<string, unknown>): Record<string, string | null> {
  const cols = TYPE_FIELDS[type] ?? [];
  const out: Record<string, string | null> = {};
  for (const col of cols) {
    const v = input[col];
    out[col] = v == null || v === '' ? null : String(v);
  }
  return out;
}

/**
 * A round-tripped placeholder is "unchanged", never a value (issue #293):
 * the app's detail pane shows `«sealed»` for secrets it has not revealed,
 * and an edit that sends it back must not overwrite the stored secret.
 */
function isPlaceholder(value: string | null): boolean {
  return value === SEALED_PLACEHOLDER;
}

const FIELD_SCHEMA: Record<string, { type: 'string' }> = Object.fromEntries(
  ALL_FIELDS.map((f) => [f, { type: 'string' }]),
);

const ADD_ITEM: CommandDefinition = {
  name: 'locker.add_item',
  ownerSchema: 'locker',
  inputSchema: {
    type: 'object',
    required: ['type', 'title'],
    additionalProperties: false,
    properties: {
      type: { type: 'string', enum: ['login', 'card', 'note', 'identity', 'wifi', 'password'] },
      title: { type: 'string', minLength: 1 },
      tags: { type: 'array', items: { type: 'string' } },
      compromised: { type: 'boolean' },
      ...FIELD_SCHEMA,
    },
  },
  outputSchema: {
    type: 'object',
    required: ['item_id'],
    properties: { item_id: { type: 'string' } },
  },
  preconditions: [],
  postconditions: [{ name: 'item_created', sql: ITEM_EXISTS_SQL, column: 'n', op: 'eq', value: 1 }],
  idempotency: 'once',
  risk: 'low',
  sealedInput: SEALED_INPUT,
  handler: (ctx) => {
    const input = ctx.input as Record<string, unknown>;
    const type = String(input.type);
    const itemId = ctx.newId();
    const f = fieldValues(type, input);
    ctx.db
      .prepare(
        `INSERT INTO locker_item
           (item_id, type, title, username, password, url, otp_seed, notes,
            cardholder, card_number, expiry, cvv, brand, content,
            fullname, email, phone, address, network, compromised, created_at, updated_at)
         VALUES
           (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        itemId,
        type,
        String(input.title),
        f.username ?? null,
        f.password ?? null,
        f.url ?? null,
        f.otp_seed ?? null,
        f.notes ?? null,
        f.cardholder ?? null,
        f.card_number ?? null,
        f.expiry ?? null,
        f.cvv ?? null,
        f.brand ?? null,
        f.content ?? null,
        f.fullname ?? null,
        f.email ?? null,
        f.phone ?? null,
        f.address ?? null,
        f.network ?? null,
        input.compromised ? 1 : 0,
        ctx.now,
        ctx.now,
      );
    ctx.wrote(LOCKER_ITEM_TYPE, itemId);
    if (Array.isArray(input.tags)) setTags(ctx, itemId, input.tags as string[]);
    ctx.cite({
      claim: `"${String(input.title)}" saved to your locker`,
      entityType: LOCKER_ITEM_TYPE,
      entityId: itemId,
    });
    return { item_id: itemId };
  },
};

const EDIT_ITEM: CommandDefinition = {
  name: 'locker.edit_item',
  ownerSchema: 'locker',
  inputSchema: {
    type: 'object',
    required: ['item_id'],
    additionalProperties: false,
    properties: {
      item_id: { type: 'string', minLength: 1 },
      title: { type: 'string', minLength: 1 },
      tags: { type: 'array', items: { type: 'string' } },
      compromised: { type: 'boolean' },
      ...FIELD_SCHEMA,
    },
  },
  outputSchema: { type: 'object', properties: { item_id: { type: 'string' } } },
  preconditions: [{ name: 'item_live', sql: ITEM_LIVE_SQL, column: 'n', op: 'eq', value: 1 }],
  postconditions: [],
  idempotency: 'idempotent',
  risk: 'low',
  sealedInput: SEALED_INPUT,
  handler: (ctx) => {
    const input = ctx.input as Record<string, unknown>;
    const itemId = String(input.item_id);
    const row = ctx.db.prepare('SELECT type FROM locker_item WHERE item_id = ?').get(itemId) as
      | { type: string }
      | undefined;
    if (!row) throw new Error('item not found');
    const f = fieldValues(row.type, input);
    // Only overwrite the type's own columns + title/compromised; leave others.
    const sets: string[] = ['updated_at = :now'];
    const params: Record<string, string | number | null> = { item_id: itemId, now: ctx.now };
    if (input.title != null) {
      sets.push('title = :title');
      params.title = String(input.title);
    }
    if (input.compromised != null) {
      sets.push('compromised = :compromised');
      params.compromised = input.compromised ? 1 : 0;
    }
    for (const [col, val] of Object.entries(f)) {
      if (isPlaceholder(val)) continue; // round-tripped «sealed» = unchanged
      sets.push(`${col} = :${col}`);
      params[col] = val;
    }
    ctx.db
      .prepare(`UPDATE locker_item SET ${sets.join(', ')} WHERE item_id = :item_id`)
      .run(params);
    ctx.wrote(LOCKER_ITEM_TYPE, itemId);
    if (Array.isArray(input.tags)) setTags(ctx, itemId, input.tags as string[]);
    return { item_id: itemId };
  },
};

const TRASH_ITEM: CommandDefinition = {
  name: 'locker.trash_item',
  ownerSchema: 'locker',
  inputSchema: {
    type: 'object',
    required: ['item_id'],
    additionalProperties: false,
    properties: { item_id: { type: 'string', minLength: 1 } },
  },
  outputSchema: { type: 'object', properties: { item_id: { type: 'string' } } },
  preconditions: [{ name: 'item_live', sql: ITEM_LIVE_SQL, column: 'n', op: 'eq', value: 1 }],
  postconditions: [
    { name: 'item_trashed', sql: ITEM_TRASHED_SQL, column: 'n', op: 'eq', value: 1 },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: (ctx) => {
    const itemId = String((ctx.input as { item_id: string }).item_id);
    ctx.db
      .prepare(
        'UPDATE locker_item SET deleted_at = :now, purge_at = :purge, updated_at = :now WHERE item_id = :item_id',
      )
      .run({ item_id: itemId, now: ctx.now, purge: plusDays(ctx.now, PURGE_WINDOW_DAYS) });
    ctx.wrote(LOCKER_ITEM_TYPE, itemId);
    return { item_id: itemId };
  },
};

const RESTORE_ITEM: CommandDefinition = {
  name: 'locker.restore_item',
  ownerSchema: 'locker',
  inputSchema: {
    type: 'object',
    required: ['item_id'],
    additionalProperties: false,
    properties: { item_id: { type: 'string', minLength: 1 } },
  },
  outputSchema: { type: 'object', properties: { item_id: { type: 'string' } } },
  preconditions: [{ name: 'item_trashed', sql: ITEM_TRASHED_SQL, column: 'n', op: 'eq', value: 1 }],
  postconditions: [{ name: 'item_live', sql: ITEM_LIVE_SQL, column: 'n', op: 'eq', value: 1 }],
  idempotency: 'idempotent',
  risk: 'low',
  handler: (ctx) => {
    const itemId = String((ctx.input as { item_id: string }).item_id);
    ctx.db
      .prepare(
        'UPDATE locker_item SET deleted_at = NULL, purge_at = NULL, updated_at = :now WHERE item_id = :item_id',
      )
      .run({ item_id: itemId, now: ctx.now });
    ctx.wrote(LOCKER_ITEM_TYPE, itemId);
    return { item_id: itemId };
  },
};

const PURGE_ITEM: CommandDefinition = {
  name: 'locker.purge_item',
  ownerSchema: 'locker',
  inputSchema: {
    type: 'object',
    required: ['item_id'],
    additionalProperties: false,
    properties: { item_id: { type: 'string', minLength: 1 } },
  },
  outputSchema: { type: 'object', properties: { item_id: { type: 'string' } } },
  preconditions: [{ name: 'item_exists', sql: ITEM_EXISTS_SQL, column: 'n', op: 'eq', value: 1 }],
  postconditions: [{ name: 'item_gone', sql: ITEM_EXISTS_SQL, column: 'n', op: 'eq', value: 0 }],
  idempotency: 'once',
  // Destructive and irreversible — elevated so it rides the app's confirmation.
  risk: 'medium',
  handler: (ctx) => {
    const itemId = String((ctx.input as { item_id: string }).item_id);
    setStarred(ctx, LOCKER_ITEM_TYPE, itemId, false);
    ctx.db.prepare('DELETE FROM locker_item_tag WHERE item_id = ?').run(itemId);
    ctx.db.prepare('DELETE FROM locker_item WHERE item_id = ?').run(itemId);
    ctx.wrote(LOCKER_ITEM_TYPE, itemId);
    return { item_id: itemId };
  },
};

const STAR_ITEM: CommandDefinition = {
  name: 'locker.star_item',
  ownerSchema: 'locker',
  inputSchema: {
    type: 'object',
    required: ['item_id'],
    additionalProperties: false,
    properties: { item_id: { type: 'string', minLength: 1 } },
  },
  outputSchema: { type: 'object', properties: { item_id: { type: 'string' } } },
  preconditions: [{ name: 'item_live', sql: ITEM_LIVE_SQL, column: 'n', op: 'eq', value: 1 }],
  postconditions: [],
  idempotency: 'idempotent',
  risk: 'low',
  handler: (ctx) => {
    const itemId = String((ctx.input as { item_id: string }).item_id);
    setStarred(ctx, LOCKER_ITEM_TYPE, itemId, true);
    return { item_id: itemId };
  },
};

const UNSTAR_ITEM: CommandDefinition = {
  name: 'locker.unstar_item',
  ownerSchema: 'locker',
  inputSchema: {
    type: 'object',
    required: ['item_id'],
    additionalProperties: false,
    properties: { item_id: { type: 'string', minLength: 1 } },
  },
  outputSchema: { type: 'object', properties: { item_id: { type: 'string' } } },
  preconditions: [{ name: 'item_live', sql: ITEM_LIVE_SQL, column: 'n', op: 'eq', value: 1 }],
  postconditions: [],
  idempotency: 'idempotent',
  risk: 'low',
  handler: (ctx) => {
    const itemId = String((ctx.input as { item_id: string }).item_id);
    setStarred(ctx, LOCKER_ITEM_TYPE, itemId, false);
    return { item_id: itemId };
  },
};

// ── Derivatives without revelation (issue #293 decision 5) ────────────────

/** RFC 4648 base32 decode (case-insensitive, spaces and padding ignored). */
function base32Decode(seed: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = seed.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error('otp seed is not valid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

const TOTP_PERIOD_S = 30;
const TOTP_DIGITS = 6;

/** RFC 6238 TOTP (HMAC-SHA1, 30s step, 6 digits) for one instant. */
export function totpAt(seed: string, epochMs: number): { code: string; remaining: number } {
  const step = Math.floor(epochMs / 1000 / TOTP_PERIOD_S);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', base32Decode(seed)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const dbc =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  const code = String(dbc % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
  const remaining = TOTP_PERIOD_S - (Math.floor(epochMs / 1000) % TOTP_PERIOD_S);
  return { code, remaining };
}

const ITEM_HAS_SEED_SQL = `SELECT count(*) AS n FROM locker_item WHERE item_id = :item_id AND deleted_at IS NULL AND otp_seed IS NOT NULL`;

const TOTP_CODE: CommandDefinition = {
  name: 'locker.totp_code',
  ownerSchema: 'locker',
  inputSchema: {
    type: 'object',
    required: ['item_id'],
    additionalProperties: false,
    properties: { item_id: { type: 'string', minLength: 1 } },
  },
  outputSchema: {
    type: 'object',
    required: ['code', 'period', 'remaining'],
    properties: {
      code: { type: 'string' },
      period: { type: 'number' },
      remaining: { type: 'number' },
    },
  },
  preconditions: [
    { name: 'item_has_seed', sql: ITEM_HAS_SEED_SQL, column: 'n', op: 'eq', value: 1 },
  ],
  postconditions: [],
  idempotency: 'retry-safe',
  risk: 'low',
  // The exemplar of the sealed class (issue #293): the seed unseals INSIDE
  // the command and only the 6 digits emerge; the unseal is receipted.
  unseals: ['locker.item.otp_seed'],
  handler: (ctx) => {
    const itemId = String((ctx.input as { item_id: string }).item_id);
    const seed = ctx.unseal(LOCKER_ITEM_TYPE, itemId, 'otp_seed');
    if (!seed) throw new Error('item has no otp seed');
    const { code, remaining } = totpAt(seed, Date.parse(ctx.now));
    return { code, period: TOTP_PERIOD_S, remaining };
  },
};

/** length + character-class score, 0..5; weak at ≤2 (mirrors the app meter). */
export function strengthScore(pw: string): number {
  if (!pw) return 0;
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 14) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/[0-9]/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  return s;
}

const WATCHTOWER: CommandDefinition = {
  name: 'locker.watchtower',
  ownerSchema: 'locker',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  outputSchema: {
    type: 'object',
    required: ['items'],
    properties: { items: { type: 'array' } },
  },
  preconditions: [],
  postconditions: [],
  idempotency: 'retry-safe',
  risk: 'low',
  // Weak/reused/last4 are computed inside the sealed boundary — only
  // booleans and a card's last four digits emerge (issue #293 decision 5).
  unseals: ['locker.item.password', 'locker.item.card_number'],
  handler: (ctx) => {
    const rows = ctx.db
      .prepare(
        `SELECT item_id, type FROM locker_item WHERE deleted_at IS NULL
          AND (type IN ('login','card') OR (type IN ('wifi','password') AND password IS NOT NULL))`,
      )
      .all() as { item_id: string; type: string }[];
    const passwords = new Map<string, string | null>();
    for (const r of rows) {
      if (r.type === 'card') continue;
      passwords.set(r.item_id, ctx.unseal(LOCKER_ITEM_TYPE, r.item_id, 'password'));
    }
    // Reused: a login password appearing on ≥2 non-trashed logins.
    const loginPwCount = new Map<string, number>();
    for (const r of rows) {
      if (r.type !== 'login') continue;
      const pw = passwords.get(r.item_id);
      if (pw) loginPwCount.set(pw, (loginPwCount.get(pw) ?? 0) + 1);
    }
    const items = rows.map((r) => {
      if (r.type === 'card') {
        const digits = (ctx.unseal(LOCKER_ITEM_TYPE, r.item_id, 'card_number') ?? '').replace(
          /\s/g,
          '',
        );
        return {
          item_id: r.item_id,
          weak: false,
          reused: false,
          ...(digits ? { last4: digits.slice(-4) } : {}),
        };
      }
      const pw = passwords.get(r.item_id);
      return {
        item_id: r.item_id,
        weak: r.type === 'login' && !!pw && strengthScore(pw) <= 2,
        reused: r.type === 'login' && !!pw && (loginPwCount.get(pw) ?? 0) >= 2,
      };
    });
    return { items };
  },
};

/** Register the Locker commands on a gateway. */
export function registerLockerCommands(gateway: Gateway): void {
  gateway.registerCommand(ADD_ITEM);
  gateway.registerCommand(EDIT_ITEM);
  gateway.registerCommand(TRASH_ITEM);
  gateway.registerCommand(RESTORE_ITEM);
  gateway.registerCommand(PURGE_ITEM);
  gateway.registerCommand(STAR_ITEM);
  gateway.registerCommand(UNSTAR_ITEM);
  gateway.registerCommand(TOTP_CODE);
  gateway.registerCommand(WATCHTOWER);
}
