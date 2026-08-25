// governance: allow-repo-hygiene file-size-limit one command pack per domain is the vault contract (registered as a unit, read wholesale); Locker owns the whole password-manager write surface — add/edit/trash/restore/purge plus the canonical star — so it is one file by design.
// Locker write surface. Favorites are NOT a column: star via flags-scheme
// (#274). Secrets (#293) are SEALED; derivatives (`totp_code`, `watchtower`)
// unseal inside the command and return only derivatives. `sealedInput` so
// the journal records keyed hashes, never values. Purge is confirm-gated.

import { createHmac } from "node:crypto";

import type { Gateway } from "../gateway/gateway.js";
import type { CommandDefinition, HandlerCtx } from "../gateway/types.js";
import { cleanupPolyRefs } from "../schema/poly-refs.js";
import { SEALED_PLACEHOLDER } from "../schema/sealed.js";
import { replaceMemo } from "./annotations.js";
import { setStarred } from "./flags.js";

export const LOCKER_ITEM_TYPE = "locker.item";

/** SKOS locker-tags scheme (#310), not a second tag table. https, not urn:. */
export const LOCKER_TAGS_SCHEME_URI =
  "https://centraid.dev/schemes/locker-tags";

const PURGE_WINDOW_DAYS = 30;

/** Columns each type owns; everything else is nulled on write. */
const TYPE_FIELDS: Record<string, readonly string[]> = {
  login: ["username", "password", "url", "otp_seed", "notes"],
  card: ["cardholder", "card_number", "expiry", "cvv", "brand"],
  note: ["content"],
  identity: ["fullname", "email", "phone", "address"],
  wifi: ["network", "password"],
  password: ["password"],
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

function lockerTagsSchemeId(ctx: HandlerCtx): string {
  const existing = ctx.db
    .prepare("SELECT scheme_id FROM core_concept_scheme WHERE uri = ?")
    .get(LOCKER_TAGS_SCHEME_URI) as { scheme_id: string } | undefined;
  if (existing) return existing.scheme_id;
  const schemeId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_concept_scheme (scheme_id, uri, title, publisher, version)
       VALUES (?, ?, 'Locker tags', 'centraid', '1')`
    )
    .run(schemeId, LOCKER_TAGS_SCHEME_URI);
  return schemeId;
}

/** Replace tags: SKOS concepts + core_tag rows, same graph as photos/docs. */
function setTags(
  ctx: HandlerCtx,
  itemId: string,
  tags: readonly string[]
): void {
  const schemeId = lockerTagsSchemeId(ctx);
  ctx.db
    .prepare(
      `DELETE FROM core_tag
        WHERE target_type = ? AND target_id = ?
          AND concept_id IN (SELECT concept_id FROM core_concept WHERE scheme_id = ?)`
    )
    .run(LOCKER_ITEM_TYPE, itemId, schemeId);
  const owner = ctx.db
    .prepare("SELECT owner_party_id FROM core_vault LIMIT 1")
    .get() as { owner_party_id: string | null } | undefined;
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = String(raw).trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    let conceptId = (
      ctx.db
        .prepare(
          "SELECT concept_id FROM core_concept WHERE scheme_id = ? AND notation = ?"
        )
        .get(schemeId, tag) as { concept_id: string } | undefined
    )?.concept_id;
    if (!conceptId) {
      conceptId = ctx.newId();
      ctx.db
        .prepare(
          `INSERT INTO core_concept (concept_id, scheme_id, notation, pref_label, alt_labels_json, broader_concept_id, definition)
           VALUES (?, ?, ?, ?, NULL, NULL, NULL)`
        )
        .run(conceptId, schemeId, tag, tag);
    }
    const tagId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO core_tag (tag_id, target_type, target_id, concept_id, tagged_by_party_id, confidence, tagged_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`
      )
      .run(
        tagId,
        LOCKER_ITEM_TYPE,
        itemId,
        conceptId,
        owner?.owner_party_id ?? null,
        ctx.now
      );
    ctx.wrote("core.tag", tagId);
  }
}

/** Set or clear (`''`) the service anchor (#310). Validated live — no opaque pointer. */
function setConnection(
  ctx: HandlerCtx,
  itemId: string,
  connectionId: string
): void {
  const trimmed = connectionId.trim();
  if (trimmed.length === 0) {
    ctx.db
      .prepare("UPDATE locker_item SET connection_id = NULL WHERE item_id = ?")
      .run(itemId);
    return;
  }
  const live = ctx.db
    .prepare("SELECT 1 AS x FROM sync_connection WHERE connection_id = ?")
    .get(trimmed);
  if (!live) throw new Error(`no sync.connection with id ${trimmed}`);
  ctx.db
    .prepare("UPDATE locker_item SET connection_id = ? WHERE item_id = ?")
    .run(trimmed, itemId);
}

/**
 * Set or clear (`''`) the connector alias (#298). Unique among LIVE items;
 * a trashed holder yields it.
 */
function setAlias(ctx: HandlerCtx, itemId: string, alias: string): void {
  ctx.db.prepare("DELETE FROM locker_item_alias WHERE item_id = ?").run(itemId);
  const trimmed = alias.trim();
  if (trimmed.length === 0) return;
  const clash = ctx.db
    .prepare(
      `SELECT a.item_id FROM locker_item_alias a
         JOIN locker_item i ON i.item_id = a.item_id
        WHERE a.alias = ? AND i.deleted_at IS NULL AND a.item_id <> ?`
    )
    .get(trimmed, itemId) as { item_id: string } | undefined;
  if (clash)
    throw new Error(`alias "${trimmed}" is already used by another live item`);
  ctx.db
    .prepare(
      "INSERT OR REPLACE INTO locker_item_alias (alias, item_id) VALUES (?, ?)"
    )
    .run(trimmed, itemId);
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
      type: {
        type: "string",
        enum: ["login", "card", "note", "identity", "wifi", "password"],
      },
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
            fullname, email, phone, address, network, compromised, created_at, updated_at)
         VALUES
           (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
  handler: (ctx) => {
    const input = ctx.input as Record<string, unknown>;
    const itemId = String(input.item_id);
    const row = ctx.db
      .prepare("SELECT type FROM locker_item WHERE item_id = ?")
      .get(itemId) as { type: string } | undefined;
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
    for (const [col, val] of Object.entries(f)) {
      if (isPlaceholder(val)) continue;
      sets.push(`${col} = :${col}`);
      params[col] = val;
    }
    ctx.db
      .prepare(
        `UPDATE locker_item SET ${sets.join(", ")} WHERE item_id = :item_id`
      )
      .run(params);
    ctx.wrote(LOCKER_ITEM_TYPE, itemId);
    if (Array.isArray(input.tags)) setTags(ctx, itemId, input.tags as string[]);
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
}
