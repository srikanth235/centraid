import type { Gateway } from "../gateway/gateway.js";
import type { CommandDefinition, HandlerCtx } from "../gateway/types.js";
import { LOCKER_ITEM_TYPE, setTags } from "./locker-shared.js";
import {
  FIELD_KINDS,
  LOCKER_FIELD_TYPE,
  addressRows,
  fieldRows,
  setAddresses,
  writeField,
  writePasskey,
} from "./locker-sidecars.js";

const ITEM_LIVE_SQL =
  "SELECT count(*) AS n FROM locker_item WHERE item_id = :item_id AND deleted_at IS NULL";
const ITEM_ARCHIVED_SQL =
  "SELECT count(*) AS n FROM locker_item WHERE item_id = :item_id AND archived_at IS NOT NULL";
const ITEM_UNARCHIVED_SQL =
  "SELECT count(*) AS n FROM locker_item WHERE item_id = :item_id AND deleted_at IS NULL AND archived_at IS NULL";

const ITEM_ID_INPUT = {
  type: "object",
  required: ["item_id"],
  additionalProperties: false,
  properties: { item_id: { type: "string", minLength: 1 } },
} as const;

const ITEM_ID_OUTPUT = {
  type: "object",
  properties: { item_id: { type: "string" } },
} as const;

const ARCHIVE_ITEM: CommandDefinition = {
  name: "locker.archive_item",
  ownerSchema: "locker",
  inputSchema: ITEM_ID_INPUT as unknown as Record<string, unknown>,
  outputSchema: ITEM_ID_OUTPUT as unknown as Record<string, unknown>,
  preconditions: [
    { name: "item_live", sql: ITEM_LIVE_SQL, column: "n", op: "eq", value: 1 },
  ],
  postconditions: [
    {
      name: "item_archived",
      sql: ITEM_ARCHIVED_SQL,
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
        "UPDATE locker_item SET archived_at = :now, updated_at = :now WHERE item_id = :item_id"
      )
      .run({ item_id: itemId, now: ctx.now });
    ctx.wrote(LOCKER_ITEM_TYPE, itemId);
    return { item_id: itemId };
  },
};

const UNARCHIVE_ITEM: CommandDefinition = {
  name: "locker.unarchive_item",
  ownerSchema: "locker",
  inputSchema: ITEM_ID_INPUT as unknown as Record<string, unknown>,
  outputSchema: ITEM_ID_OUTPUT as unknown as Record<string, unknown>,
  preconditions: [
    { name: "item_live", sql: ITEM_LIVE_SQL, column: "n", op: "eq", value: 1 },
  ],
  postconditions: [
    {
      name: "item_unarchived",
      sql: ITEM_UNARCHIVED_SQL,
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
        "UPDATE locker_item SET archived_at = NULL, updated_at = :now WHERE item_id = :item_id"
      )
      .run({ item_id: itemId, now: ctx.now });
    ctx.wrote(LOCKER_ITEM_TYPE, itemId);
    return { item_id: itemId };
  },
};

const PLAIN_COPY_COLUMNS = [
  "type",
  "username",
  "url",
  "url_match_policy",
  "notes",
  "cardholder",
  "expiry",
  "brand",
  "fullname",
  "email",
  "phone",
  "address",
  "network",
  "connection_id",
  "compromised",
] as const;

const SEALED_ITEM_COLUMNS = [
  "password",
  "otp_seed",
  "card_number",
  "cvv",
  "content",
] as const;

const DUPLICATE_ITEM: CommandDefinition = {
  name: "locker.duplicate_item",
  ownerSchema: "locker",
  inputSchema: ITEM_ID_INPUT as unknown as Record<string, unknown>,
  outputSchema: {
    type: "object",
    required: ["item_id"],
    properties: { item_id: { type: "string" }, title: { type: "string" } },
  },
  preconditions: [
    { name: "item_live", sql: ITEM_LIVE_SQL, column: "n", op: "eq", value: 1 },
  ],
  postconditions: [],
  idempotency: "once",
  risk: "low",
  unseals: [
    ...SEALED_ITEM_COLUMNS.map((column) => `${LOCKER_ITEM_TYPE}.${column}`),
    `${LOCKER_FIELD_TYPE}.value_sealed`,
  ],
  handler: (ctx) => {
    const sourceId = String((ctx.input as { item_id: string }).item_id);
    const row = ctx.db
      .prepare("SELECT * FROM locker_item WHERE item_id = ?")
      .get(sourceId) as Record<string, unknown> | undefined;
    if (!row) throw new Error("item not found");
    const itemId = ctx.newId();
    const title = `${String(row.title)} copy`;
    const columns = [...PLAIN_COPY_COLUMNS];
    const values = columns.map((column) => (row[column] ?? null) as never);
    ctx.db
      .prepare(
        `INSERT INTO locker_item
           (item_id, title, password_set_at, created_at, updated_at, ${columns.join(", ")})
         VALUES (?, ?, ?, ?, ?, ${columns.map(() => "?").join(", ")})`
      )
      .run(
        itemId,
        title,
        (row.password_set_at ?? null) as never,
        ctx.now,
        ctx.now,
        ...values
      );
    for (const column of SEALED_ITEM_COLUMNS) {
      const plain = ctx.unseal(LOCKER_ITEM_TYPE, sourceId, column);
      if (plain == null) continue;
      ctx.db
        .prepare(`UPDATE locker_item SET "${column}" = ? WHERE item_id = ?`)
        .run(plain, itemId);
    }
    ctx.wrote(LOCKER_ITEM_TYPE, itemId);
    for (const field of fieldRows(ctx, sourceId)) {
      writeField(ctx, itemId, {
        section: field.section,
        label: field.label,
        kind: field.kind,
        position: field.position,
        value:
          field.kind === "sealed"
            ? ctx.unseal(LOCKER_FIELD_TYPE, field.field_id, "value_sealed")
            : field.value_text,
      });
    }
    setAddresses(
      ctx,
      itemId,
      addressRows(ctx, sourceId).map((address) => ({
        url: address.url,
        matchPolicy: address.match_policy,
      }))
    );
    setTags(ctx, itemId, tagLabels(ctx, sourceId));
    ctx.cite({
      claim: `"${title}" duplicated from an existing locker item`,
      entityType: LOCKER_ITEM_TYPE,
      entityId: itemId,
    });
    return { item_id: itemId, title };
  },
};

function tagLabels(ctx: HandlerCtx, itemId: string): string[] {
  return (
    ctx.db
      .prepare(
        `SELECT c.pref_label AS label FROM core_tag t
           JOIN core_concept c ON c.concept_id = t.concept_id
           JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
          WHERE t.target_type = ? AND t.target_id = ?
            AND s.uri = 'https://centraid.dev/schemes/locker-tags'
          ORDER BY c.pref_label`
      )
      .all(LOCKER_ITEM_TYPE, itemId) as { label: string }[]
  ).map((tag) => tag.label);
}

const SET_FIELD: CommandDefinition = {
  name: "locker.set_field",
  ownerSchema: "locker",
  inputSchema: {
    type: "object",
    required: ["item_id", "label", "kind"],
    additionalProperties: false,
    properties: {
      item_id: { type: "string", minLength: 1 },
      field_id: { type: "string", minLength: 1 },
      section: { type: "string" },
      label: { type: "string", minLength: 1 },
      kind: { type: "string", enum: [...FIELD_KINDS] },
      value: { type: "string" },
      position: { type: "integer", minimum: 0 },
    },
  },
  outputSchema: {
    type: "object",
    required: ["field_id"],
    properties: { field_id: { type: "string" }, item_id: { type: "string" } },
  },
  preconditions: [
    { name: "item_live", sql: ITEM_LIVE_SQL, column: "n", op: "eq", value: 1 },
  ],
  postconditions: [],
  idempotency: "idempotent",
  risk: "low",
  sealedInput: ["value"],
  handler: (ctx) => {
    const input = ctx.input as Record<string, unknown>;
    const itemId = String(input.item_id);
    const fieldId = writeField(ctx, itemId, {
      ...(input.field_id ? { fieldId: String(input.field_id) } : {}),
      section: String(input.section ?? ""),
      label: String(input.label),
      kind: String(input.kind),
      ...(input.value == null ? {} : { value: String(input.value) }),
      ...(input.position == null ? {} : { position: Number(input.position) }),
    });
    ctx.wrote(LOCKER_ITEM_TYPE, itemId);
    return { field_id: fieldId, item_id: itemId };
  },
};

const REMOVE_FIELD: CommandDefinition = {
  name: "locker.remove_field",
  ownerSchema: "locker",
  inputSchema: {
    type: "object",
    required: ["item_id", "field_id"],
    additionalProperties: false,
    properties: {
      item_id: { type: "string", minLength: 1 },
      field_id: { type: "string", minLength: 1 },
    },
  },
  outputSchema: {
    type: "object",
    properties: { field_id: { type: "string" }, item_id: { type: "string" } },
  },
  preconditions: [
    { name: "item_live", sql: ITEM_LIVE_SQL, column: "n", op: "eq", value: 1 },
  ],
  postconditions: [],
  idempotency: "idempotent",
  risk: "low",
  handler: (ctx) => {
    const input = ctx.input as { item_id: string; field_id: string };
    ctx.db
      .prepare(
        "DELETE FROM locker_item_field WHERE field_id = ? AND item_id = ?"
      )
      .run(input.field_id, input.item_id);
    ctx.wrote(LOCKER_FIELD_TYPE, input.field_id);
    ctx.wrote(LOCKER_ITEM_TYPE, input.item_id);
    return { field_id: input.field_id, item_id: input.item_id };
  },
};

const SET_ADDRESSES: CommandDefinition = {
  name: "locker.set_addresses",
  ownerSchema: "locker",
  inputSchema: {
    type: "object",
    required: ["item_id", "addresses"],
    additionalProperties: false,
    properties: {
      item_id: { type: "string", minLength: 1 },
      addresses: {
        type: "array",
        items: {
          type: "object",
          required: ["url"],
          additionalProperties: false,
          properties: {
            url: { type: "string", minLength: 1 },
            match_policy: {
              type: "string",
              enum: ["registrable-domain", "exact-host"],
            },
          },
        },
      },
    },
  },
  outputSchema: {
    type: "object",
    properties: { item_id: { type: "string" }, count: { type: "number" } },
  },
  preconditions: [
    { name: "item_live", sql: ITEM_LIVE_SQL, column: "n", op: "eq", value: 1 },
  ],
  postconditions: [],
  idempotency: "idempotent",
  risk: "low",
  handler: (ctx) => {
    const input = ctx.input as {
      item_id: string;
      addresses: { url: string; match_policy?: string }[];
    };
    const count = setAddresses(
      ctx,
      input.item_id,
      input.addresses.map((address) => ({
        url: address.url,
        ...(address.match_policy ? { matchPolicy: address.match_policy } : {}),
      }))
    );
    ctx.wrote(LOCKER_ITEM_TYPE, input.item_id);
    return { item_id: input.item_id, count };
  },
};

const SET_PASSKEY: CommandDefinition = {
  name: "locker.set_passkey",
  ownerSchema: "locker",
  inputSchema: {
    type: "object",
    required: ["item_id", "rp_id"],
    additionalProperties: false,
    properties: {
      item_id: { type: "string", minLength: 1 },
      rp_id: { type: "string", minLength: 1 },
      user_handle: { type: "string" },
      display_name: { type: "string" },
      credential_id: { type: "string" },
      algorithm: { type: "string" },
      private_key: { type: "string" },
    },
  },
  outputSchema: ITEM_ID_OUTPUT as unknown as Record<string, unknown>,
  preconditions: [
    { name: "item_live", sql: ITEM_LIVE_SQL, column: "n", op: "eq", value: 1 },
  ],
  postconditions: [],
  idempotency: "idempotent",
  risk: "low",
  sealedInput: ["private_key"],
  handler: (ctx) => {
    const input = ctx.input as Record<string, unknown>;
    const itemId = String(input.item_id);
    writePasskey(ctx, itemId, {
      rpId: String(input.rp_id),
      userHandle: input.user_handle == null ? null : String(input.user_handle),
      displayName:
        input.display_name == null ? null : String(input.display_name),
      credentialId:
        input.credential_id == null ? null : String(input.credential_id),
      algorithm: input.algorithm == null ? null : String(input.algorithm),
      privateKey: input.private_key == null ? null : String(input.private_key),
    });
    ctx.wrote(LOCKER_ITEM_TYPE, itemId);
    return { item_id: itemId };
  },
};

const CLEAR_PASSKEY: CommandDefinition = {
  name: "locker.clear_passkey",
  ownerSchema: "locker",
  inputSchema: ITEM_ID_INPUT as unknown as Record<string, unknown>,
  outputSchema: ITEM_ID_OUTPUT as unknown as Record<string, unknown>,
  preconditions: [
    { name: "item_live", sql: ITEM_LIVE_SQL, column: "n", op: "eq", value: 1 },
  ],
  postconditions: [],
  idempotency: "idempotent",
  risk: "low",
  handler: (ctx) => {
    const itemId = String((ctx.input as { item_id: string }).item_id);
    ctx.db
      .prepare("DELETE FROM locker_item_passkey WHERE item_id = ?")
      .run(itemId);
    ctx.wrote("locker.item_passkey", itemId);
    ctx.wrote(LOCKER_ITEM_TYPE, itemId);
    return { item_id: itemId };
  },
};

const COUNTS: CommandDefinition = {
  name: "locker.counts",
  ownerSchema: "locker",
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
  outputSchema: {
    type: "object",
    required: ["live", "archived", "trashed", "by_type"],
    properties: {
      live: { type: "number" },
      archived: { type: "number" },
      trashed: { type: "number" },
      by_type: { type: "array" },
    },
  },
  preconditions: [],
  postconditions: [],
  idempotency: "retry-safe",
  risk: "low",
  handler: (ctx) => {
    const one = (sql: string): number =>
      Number((ctx.db.prepare(sql).get() as { n: number }).n);
    return {
      live: one(
        "SELECT count(*) AS n FROM locker_item WHERE deleted_at IS NULL AND archived_at IS NULL"
      ),
      archived: one(
        "SELECT count(*) AS n FROM locker_item WHERE deleted_at IS NULL AND archived_at IS NOT NULL"
      ),
      trashed: one(
        "SELECT count(*) AS n FROM locker_item WHERE deleted_at IS NOT NULL"
      ),
      by_type: ctx.db
        .prepare(
          `SELECT type, count(*) AS n FROM locker_item
            WHERE deleted_at IS NULL AND archived_at IS NULL
            GROUP BY type ORDER BY type`
        )
        .all() as { type: string; n: number }[],
    };
  },
};

export function registerLockerExtraCommands(gateway: Gateway): void {
  gateway.registerCommand(ARCHIVE_ITEM);
  gateway.registerCommand(UNARCHIVE_ITEM);
  gateway.registerCommand(DUPLICATE_ITEM);
  gateway.registerCommand(SET_FIELD);
  gateway.registerCommand(REMOVE_FIELD);
  gateway.registerCommand(SET_ADDRESSES);
  gateway.registerCommand(SET_PASSKEY);
  gateway.registerCommand(CLEAR_PASSKEY);
  gateway.registerCommand(COUNTS);
}
