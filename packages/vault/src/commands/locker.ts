// governance: allow-repo-hygiene file-size-limit one command pack per domain is the vault contract (registered as a unit, read wholesale); Locker owns the whole password-manager write surface — add/edit/trash/restore/purge plus the canonical star — so it is one file by design.
// Locker write surface. Favorites are NOT a column: star via flags-scheme
// (#274). Secrets (#293) are SEALED; derivatives (`totp_code`, `watchtower`)
// unseal inside the command and return only derivatives. `sealedInput` so
// the journal records keyed hashes, never values. Purge is confirm-gated.

import { createHmac } from "node:crypto";

import type { Gateway } from "../gateway/gateway.js";
import type { CommandDefinition } from "../gateway/types.js";
import { cleanupPolyRefs } from "../schema/poly-refs.js";
import { SEALED_PLACEHOLDER } from "../schema/sealed.js";
import { replaceMemo } from "./annotations.js";
import { setStarred } from "./flags.js";
import { registerLockerExportCommand } from "./locker-export.js";
import { registerLockerExtraCommands } from "./locker-extras.js";
import {
  LOCKER_ITEM_TYPE,
  setAlias,
  setConnection,
  setTags,
} from "./locker-shared.js";
import { mintTemplateFields, recordHistory } from "./locker-sidecars.js";
import { LOCKER_ITEM_TYPES } from "./locker-types.js";

// The domain vocabulary moved to `locker-shared.js` when the write surface
// outgrew one file (#872); re-exported here so every existing importer of
// `commands/locker.js` keeps working.
export { LOCKER_ITEM_TYPE } from "./locker-shared.js";

const PURGE_WINDOW_DAYS = 30;

/**
 * Columns each type owns; everything else is nulled on write. The nine types
 * #872 added own exactly ONE column — the plaintext memo every item can carry
 * — because their real fields are template rows in `locker_item_field`
 * (`locker-types.ts`). That is the "a type is a set of sections and fields"
 * rule made structural: adding a type never adds a column.
 */
const TEMPLATE_TYPE_FIELDS: readonly string[] = ["notes"];

const TYPE_FIELDS: Record<string, readonly string[]> = {
  login: ["username", "password", "url", "otp_seed", "notes"],
  card: ["cardholder", "card_number", "expiry", "cvv", "brand"],
  note: ["content"],
  identity: ["fullname", "email", "phone", "address"],
  wifi: ["network", "password"],
  password: ["password"],
  ssh_key: TEMPLATE_TYPE_FIELDS,
  api_credential: TEMPLATE_TYPE_FIELDS,
  passport: TEMPLATE_TYPE_FIELDS,
  bank_account: TEMPLATE_TYPE_FIELDS,
  driving_licence: TEMPLATE_TYPE_FIELDS,
  software_licence: TEMPLATE_TYPE_FIELDS,
  crypto_wallet: TEMPLATE_TYPE_FIELDS,
  membership: TEMPLATE_TYPE_FIELDS,
  document: TEMPLATE_TYPE_FIELDS,
};

const ALL_FIELDS = [
  "username",
  "password",
  "url",
  "otp_seed",
  "notes",
  "cardholder",
  "card_number",
  "expiry",
  "cvv",
  "brand",
  "content",
  "fullname",
  "email",
  "phone",
  "address",
  "network",
] as const;

/** Journal records keyed hashes at these paths, never values (#293). */
const SEALED_INPUT = [
  "password",
  "otp_seed",
  "card_number",
  "cvv",
  "content",
] as const;

const ITEM_EXISTS_SQL =
  "SELECT count(*) AS n FROM locker_item WHERE item_id = :item_id";
const ITEM_LIVE_SQL =
  "SELECT count(*) AS n FROM locker_item WHERE item_id = :item_id AND deleted_at IS NULL";
const ITEM_TRASHED_SQL =
  "SELECT count(*) AS n FROM locker_item WHERE item_id = :item_id AND deleted_at IS NOT NULL";

function plusDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

function fieldValues(
  type: string,
  input: Record<string, unknown>
): Record<string, string | null> {
  const cols = TYPE_FIELDS[type] ?? [];
  const out: Record<string, string | null> = {};
  for (const col of cols) {
    const v = input[col];
    out[col] = v == null || v === "" ? null : String(v);
  }
  return out;
}

/** Round-tripped `«sealed»` is unchanged, never a value (#293). */
function isPlaceholder(value: string | null): boolean {
  return value === SEALED_PLACEHOLDER;
}

const FIELD_SCHEMA: Record<string, { type: "string" }> = Object.fromEntries(
  ALL_FIELDS.map((f) => [f, { type: "string" }])
);

const ADD_ITEM: CommandDefinition = {
  name: "locker.add_item",
  ownerSchema: "locker",
  inputSchema: {
    type: "object",
    required: ["type", "title"],
    additionalProperties: false,
    properties: {
      // The fifteen types this build knows. The nine added by #872 own no
      // columns of their own — see `locker-types.ts`: a type is a template of
      // sections and fields, minted into `locker_item_field` below.
      type: { type: "string", enum: [...LOCKER_ITEM_TYPES] },
      title: { type: "string", minLength: 1 },
      tags: { type: "array", items: { type: "string" } },
      compromised: { type: "boolean" },
      // Connector-binding token (#298) in `locker:@<alias>:<column>`.
      alias: { type: "string", pattern: "^[A-Za-z0-9._-]{1,64}$" },
      // Service anchor (#310), validated live.
      connection_id: { type: "string" },
      url_match_policy: {
        type: "string",
        enum: ["registrable-domain", "exact-host"],
      },
      ...FIELD_SCHEMA,
    },
  },
  outputSchema: {
    type: "object",
    required: ["item_id"],
    properties: { item_id: { type: "string" } },
  },
  preconditions: [],
  postconditions: [
    {
      name: "item_created",
      sql: ITEM_EXISTS_SQL,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "once",
  risk: "low",
  sealedInput: SEALED_INPUT,
  handler: (ctx) => {
    const input = ctx.input as Record<string, unknown>;
    const type = String(input.type);
    const itemId = ctx.newId();
    const f = fieldValues(type, input);
    ctx.db
      .prepare(
        `INSERT INTO locker_item
           (item_id, type, title, username, password, url, url_match_policy, otp_seed, notes,
            cardholder, card_number, expiry, cvv, brand, content,
            fullname, email, phone, address, network, compromised,
            password_set_at, created_at, updated_at)
         VALUES
           (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        itemId,
        type,
        String(input.title),
        f.username ?? null,
        f.password ?? null,
        f.url ?? null,
        input.url_match_policy === "exact-host"
          ? "exact-host"
          : "registrable-domain",
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
        // Password age is set-time, never updated_at: a retag must not make a
        // three-year-old password look fresh (GAPS §3.3 #6d).
        f.password == null ? null : ctx.now,
        ctx.now,
        ctx.now
      );
    if (typeof input.alias === "string" && input.alias.length > 0) {
      setAlias(ctx, itemId, input.alias);
    }
    if (
      typeof input.connection_id === "string" &&
      input.connection_id.length > 0
    ) {
      setConnection(ctx, itemId, input.connection_id);
    }
    ctx.wrote(LOCKER_ITEM_TYPE, itemId);
    if (Array.isArray(input.tags)) setTags(ctx, itemId, input.tags as string[]);
    // A type is a set of sections and fields: the nine expansion types arrive
    // as empty template rows the member fills in, which is also what lets an
    // unknown type degrade to a note that still carries them.
    mintTemplateFields(ctx, itemId, type);
    recordHistory(ctx, itemId, {
      operation: "create",
      title: String(input.title),
      changed: { type },
    });
    ctx.cite({
      claim: `"${String(input.title)}" saved to your locker`,
      entityType: LOCKER_ITEM_TYPE,
      entityId: itemId,
    });
    return { item_id: itemId };
  },
};

const EDIT_ITEM: CommandDefinition = {
  name: "locker.edit_item",
  ownerSchema: "locker",
  inputSchema: {
    type: "object",
    required: ["item_id"],
    additionalProperties: false,
    properties: {
      item_id: { type: "string", minLength: 1 },
      title: { type: "string", minLength: 1 },
      tags: { type: "array", items: { type: "string" } },
      compromised: { type: "boolean" },
      // Re-point; '' clears.
      alias: { type: "string", pattern: "^[A-Za-z0-9._-]{0,64}$" },
      // Re-anchor; '' clears.
      connection_id: { type: "string" },
      url_match_policy: {
        type: "string",
        enum: ["registrable-domain", "exact-host"],
      },
      ...FIELD_SCHEMA,
    },
  },
  outputSchema: { type: "object", properties: { item_id: { type: "string" } } },
  preconditions: [
    { name: "item_live", sql: ITEM_LIVE_SQL, column: "n", op: "eq", value: 1 },
  ],
  postconditions: [],
  idempotency: "idempotent",
  risk: "low",
  sealedInput: SEALED_INPUT,
  // History (#872, GAPS §3.3 #5) needs the OUTGOING password in the clear, so
  // it can be resealed against the history row's own cell — the ciphertext
  // cannot be copied across, its AAD binds it to the item. Declaring the
  // unseal is what puts the rotation on the invocation's receipt: an edit that
  // changes a password says so, by column name, never by value.
  unseals: [`${LOCKER_ITEM_TYPE}.password`],
  handler: (ctx) => {
    const input = ctx.input as Record<string, unknown>;
    const itemId = String(input.item_id);
    const row = ctx.db
      .prepare("SELECT type, title FROM locker_item WHERE item_id = ?")
      .get(itemId) as { type: string; title: string } | undefined;
    if (!row) throw new Error("item not found");
    const f = fieldValues(row.type, input);
    // Only the type's own columns + title/compromised.
    const sets: string[] = ["updated_at = :now"];
    const params: Record<string, string | number | null> = {
      item_id: itemId,
      now: ctx.now,
    };
    if (input.title != null) {
      sets.push("title = :title");
      params.title = String(input.title);
    }
    if (input.compromised != null) {
      sets.push("compromised = :compromised");
      params.compromised = input.compromised ? 1 : 0;
    }
    if (input.alias != null) {
      // Empty string clears the alias.
      setAlias(ctx, itemId, String(input.alias));
    }
    if (input.connection_id != null) {
      setConnection(ctx, itemId, String(input.connection_id));
    }
    if (input.url_match_policy != null) {
      if (row.type !== "login")
        throw new Error("url_match_policy is login-only");
      sets.push("url_match_policy = :url_match_policy");
      params.url_match_policy = String(input.url_match_policy);
    }
    const changed: string[] = [];
    for (const [col, val] of Object.entries(f)) {
      if (isPlaceholder(val)) continue;
      sets.push(`${col} = :${col}`);
      params[col] = val;
      changed.push(col);
    }
    // A password ROTATION, distinguished from any other edit: the previous
    // value goes to history sealed, and only a real change re-stamps the age.
    const previousPassword = changed.includes("password")
      ? ctx.unseal(LOCKER_ITEM_TYPE, itemId, "password")
      : null;
    const rotated =
      changed.includes("password") && (f.password ?? null) !== previousPassword;
    if (rotated) {
      sets.push("password_set_at = :password_set_at");
      params.password_set_at = f.password == null ? null : ctx.now;
    }
    ctx.db
      .prepare(
        `UPDATE locker_item SET ${sets.join(", ")} WHERE item_id = :item_id`
      )
      .run(params);
    ctx.wrote(LOCKER_ITEM_TYPE, itemId);
    if (Array.isArray(input.tags)) setTags(ctx, itemId, input.tags as string[]);
    recordHistory(ctx, itemId, {
      operation: "edit",
      title: row.title,
      ...(rotated && previousPassword != null ? { previousPassword } : {}),
      changed: {
        fields: changed,
        ...(rotated ? { password_rotated: true } : {}),
        ...(input.title == null ? {} : { title: true }),
        ...(Array.isArray(input.tags) ? { tags: true } : {}),
        ...(input.alias == null ? {} : { alias: true }),
      },
    });
    return { item_id: itemId };
  },
};

const TRASH_ITEM: CommandDefinition = {
  name: "locker.trash_item",
  ownerSchema: "locker",
  inputSchema: {
    type: "object",
    required: ["item_id"],
    additionalProperties: false,
    properties: { item_id: { type: "string", minLength: 1 } },
  },
  outputSchema: { type: "object", properties: { item_id: { type: "string" } } },
  preconditions: [
    { name: "item_live", sql: ITEM_LIVE_SQL, column: "n", op: "eq", value: 1 },
  ],
  postconditions: [
    {
      name: "item_trashed",
      sql: ITEM_TRASHED_SQL,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "idempotent",
  risk: "low",
  handler: (ctx) => {
    const itemId = String((ctx.input as { item_id: string }).item_id);
    ctx.db
      .prepare(
        "UPDATE locker_item SET deleted_at = :now, purge_at = :purge, updated_at = :now WHERE item_id = :item_id"
      )
      .run({
        item_id: itemId,
        now: ctx.now,
        purge: plusDays(ctx.now, PURGE_WINDOW_DAYS),
      });
    ctx.wrote(LOCKER_ITEM_TYPE, itemId);
    return { item_id: itemId };
  },
};

const RESTORE_ITEM: CommandDefinition = {
  name: "locker.restore_item",
  ownerSchema: "locker",
  inputSchema: {
    type: "object",
    required: ["item_id"],
    additionalProperties: false,
    properties: { item_id: { type: "string", minLength: 1 } },
  },
  outputSchema: { type: "object", properties: { item_id: { type: "string" } } },
  preconditions: [
    {
      name: "item_trashed",
      sql: ITEM_TRASHED_SQL,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    { name: "item_live", sql: ITEM_LIVE_SQL, column: "n", op: "eq", value: 1 },
  ],
  idempotency: "idempotent",
  risk: "low",
  handler: (ctx) => {
    const itemId = String((ctx.input as { item_id: string }).item_id);
    ctx.db
      .prepare(
        "UPDATE locker_item SET deleted_at = NULL, purge_at = NULL, updated_at = :now WHERE item_id = :item_id"
      )
      .run({ item_id: itemId, now: ctx.now });
    ctx.wrote(LOCKER_ITEM_TYPE, itemId);
    return { item_id: itemId };
  },
};

const PURGE_ITEM: CommandDefinition = {
  name: "locker.purge_item",
  ownerSchema: "locker",
  inputSchema: {
    type: "object",
    required: ["item_id"],
    additionalProperties: false,
    properties: { item_id: { type: "string", minLength: 1 } },
  },
  outputSchema: { type: "object", properties: { item_id: { type: "string" } } },
  preconditions: [
    {
      name: "item_exists",
      sql: ITEM_EXISTS_SQL,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "item_gone",
      sql: ITEM_EXISTS_SQL,
      column: "n",
      op: "eq",
      value: 0,
    },
  ],
  idempotency: "once",
  risk: "medium",
  // Destructive (#306 d2): park for owner confirm on every non-owner-device
  // invoke. Without this the manifest's "confirmation": "required" is cosmetic.
  confirm: true,
  handler: (ctx) => {
    const itemId = String((ctx.input as { item_id: string }).item_id);
    setStarred(ctx, LOCKER_ITEM_TYPE, itemId, false);
    setTags(ctx, itemId, []); // core_tag is polymorphic — no CASCADE
    // The sidecars declare ON DELETE CASCADE, but a cascade fires no AFTER
    // DELETE trigger unless recursive_triggers is on — so an offline phone
    // would keep rows whose item is gone. Deleted explicitly, in the same
    // transaction, so the replica change log carries every one of them.
    for (const table of [
      "locker_item_field",
      "locker_item_address",
      "locker_item_passkey",
      "locker_item_history",
      "locker_item_alias",
    ]) {
      ctx.db.prepare(`DELETE FROM ${table} WHERE item_id = ?`).run(itemId);
    }
    ctx.db.prepare("DELETE FROM locker_item WHERE item_id = ?").run(itemId);
    cleanupPolyRefs(ctx.db, ctx.now, LOCKER_ITEM_TYPE, itemId);
    ctx.wrote(LOCKER_ITEM_TYPE, itemId);
    return { item_id: itemId };
  },
};

const STAR_ITEM: CommandDefinition = {
  name: "locker.star_item",
  ownerSchema: "locker",
  inputSchema: {
    type: "object",
    required: ["item_id"],
    additionalProperties: false,
    properties: { item_id: { type: "string", minLength: 1 } },
  },
  outputSchema: { type: "object", properties: { item_id: { type: "string" } } },
  preconditions: [
    { name: "item_live", sql: ITEM_LIVE_SQL, column: "n", op: "eq", value: 1 },
  ],
  postconditions: [],
  idempotency: "idempotent",
  risk: "low",
  handler: (ctx) => {
    const itemId = String((ctx.input as { item_id: string }).item_id);
    setStarred(ctx, LOCKER_ITEM_TYPE, itemId, true);
    return { item_id: itemId };
  },
};

const UNSTAR_ITEM: CommandDefinition = {
  name: "locker.unstar_item",
  ownerSchema: "locker",
  inputSchema: {
    type: "object",
    required: ["item_id"],
    additionalProperties: false,
    properties: { item_id: { type: "string", minLength: 1 } },
  },
  outputSchema: { type: "object", properties: { item_id: { type: "string" } } },
  preconditions: [
    { name: "item_live", sql: ITEM_LIVE_SQL, column: "n", op: "eq", value: 1 },
  ],
  postconditions: [],
  idempotency: "idempotent",
  risk: "low",
  handler: (ctx) => {
    const itemId = String((ctx.input as { item_id: string }).item_id);
    setStarred(ctx, LOCKER_ITEM_TYPE, itemId, false);
    return { item_id: itemId };
  },
};

// ── Derivatives without revelation (issue #293 decision 5) ────────────────

function base32Decode(seed: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = seed.toUpperCase().replace(/[\s=-]/gu, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error("otp seed is not valid base32");
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

export function totpAt(
  seed: string,
  epochMs: number
): { code: string; remaining: number } {
  const step = Math.floor(epochMs / 1000 / TOTP_PERIOD_S);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", base32Decode(seed))
    .update(counter)
    .digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const dbc =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  const code = String(dbc % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
  const remaining =
    TOTP_PERIOD_S - (Math.floor(epochMs / 1000) % TOTP_PERIOD_S);
  return { code, remaining };
}

const ITEM_HAS_SEED_SQL = `SELECT count(*) AS n FROM locker_item WHERE item_id = :item_id AND deleted_at IS NULL AND otp_seed IS NOT NULL`;

const TOTP_CODE: CommandDefinition = {
  name: "locker.totp_code",
  ownerSchema: "locker",
  inputSchema: {
    type: "object",
    required: ["item_id"],
    additionalProperties: false,
    properties: { item_id: { type: "string", minLength: 1 } },
  },
  outputSchema: {
    type: "object",
    required: ["code", "period", "remaining"],
    properties: {
      code: { type: "string" },
      period: { type: "number" },
      remaining: { type: "number" },
    },
  },
  preconditions: [
    {
      name: "item_has_seed",
      sql: ITEM_HAS_SEED_SQL,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [],
  idempotency: "retry-safe",
  risk: "low",
  // Seed unseals INSIDE the command; only the 6 digits emerge (#293).
  unseals: ["locker.item.otp_seed"],
  // Secret-derived (#298): live to the caller, redacted from the journal.
  transcriptSensitive: true,
  handler: (ctx) => {
    const itemId = String((ctx.input as { item_id: string }).item_id);
    const seed = ctx.unseal(LOCKER_ITEM_TYPE, itemId, "otp_seed");
    if (!seed) throw new Error("item has no otp seed");
    const { code, remaining } = totpAt(seed, Date.parse(ctx.now));
    return { code, period: TOTP_PERIOD_S, remaining };
  },
};

/** 0..5; weak at ≤2 (mirrors the app meter). */
export function strengthScore(pw: string): number {
  if (!pw) return 0;
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 14) s++;
  if (/[A-Z]/u.test(pw) && /[a-z]/u.test(pw)) s++;
  if (/[0-9]/u.test(pw)) s++;
  if (/[^A-Za-z0-9]/u.test(pw)) s++;
  return s;
}

const WATCHTOWER: CommandDefinition = {
  name: "locker.watchtower",
  ownerSchema: "locker",
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
  outputSchema: {
    type: "object",
    required: ["items"],
    properties: { items: { type: "array" } },
  },
  preconditions: [],
  postconditions: [],
  idempotency: "retry-safe",
  risk: "low",
  // Computed inside the sealed boundary — only booleans + last4 emerge (#293 d5).
  unseals: ["locker.item.password", "locker.item.card_number"],
  handler: (ctx) => {
    const rows = ctx.db
      .prepare(
        `SELECT item_id, type FROM locker_item WHERE deleted_at IS NULL
          AND (type IN ('login','card') OR (type IN ('wifi','password') AND password IS NOT NULL))`
      )
      .all() as { item_id: string; type: string }[];
    const passwords = new Map<string, string | null>();
    for (const r of rows) {
      if (r.type === "card") continue;
      passwords.set(
        r.item_id,
        ctx.unseal(LOCKER_ITEM_TYPE, r.item_id, "password")
      );
    }
    // Reused: same password on ≥2 live logins.
    const loginPwCount = new Map<string, number>();
    for (const r of rows) {
      if (r.type !== "login") continue;
      const pw = passwords.get(r.item_id);
      if (pw) loginPwCount.set(pw, (loginPwCount.get(pw) ?? 0) + 1);
    }
    const items = rows.map((r) => {
      if (r.type === "card") {
        const digits = (
          ctx.unseal(LOCKER_ITEM_TYPE, r.item_id, "card_number") ?? ""
        ).replace(/\s/gu, "");
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
        weak: r.type === "login" && !!pw && strengthScore(pw) <= 2,
        reused: r.type === "login" && !!pw && (loginPwCount.get(pw) ?? 0) >= 2,
      };
    });
    return { items };
  },
};

const SET_MEMO: CommandDefinition = {
  name: "locker.set_memo",
  ownerSchema: "locker",
  inputSchema: {
    type: "object",
    required: ["item_id", "note"],
    additionalProperties: false,
    properties: {
      item_id: { type: "string", minLength: 1 },
      // '' clears the memo.
      note: { type: "string" },
    },
  },
  outputSchema: { type: "object", properties: { item_id: { type: "string" } } },
  preconditions: [
    { name: "item_live", sql: ITEM_LIVE_SQL, column: "n", op: "eq", value: 1 },
  ],
  postconditions: [],
  idempotency: "idempotent",
  risk: "low",
  handler: (ctx) => {
    // Owner remark is knowledge.annotation (#310), plaintext. Secrets go in
    // SEALED fields, which stay out of every index.
    const input = ctx.input as { item_id: string; note: string };
    replaceMemo(ctx, LOCKER_ITEM_TYPE, input.item_id, input.note);
    ctx.wrote(LOCKER_ITEM_TYPE, input.item_id);
    return { item_id: input.item_id };
  },
};

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
  gateway.registerCommand(SET_MEMO);
  // The #872 surface: archive, duplicate, custom fields, addresses, passkey,
  // counts — and the plaintext export, which is its own module because the
  // reasoning for a mass reveal being a COMMAND is worth reading in one place.
  registerLockerExtraCommands(gateway);
  registerLockerExportCommand(gateway);
}
