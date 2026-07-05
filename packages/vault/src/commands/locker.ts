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
// Secret handling: secret columns are written verbatim here (the vault file
// is the security boundary); this pack never logs a secret, and the read
// projection — not this pack — is what keeps secrets out of list payloads.

import type { Gateway } from '../gateway/gateway.js';
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

/** Register the Locker commands on a gateway. */
export function registerLockerCommands(gateway: Gateway): void {
  gateway.registerCommand(ADD_ITEM);
  gateway.registerCommand(EDIT_ITEM);
  gateway.registerCommand(TRASH_ITEM);
  gateway.registerCommand(RESTORE_ITEM);
  gateway.registerCommand(PURGE_ITEM);
  gateway.registerCommand(STAR_ITEM);
  gateway.registerCommand(UNSTAR_ITEM);
}
