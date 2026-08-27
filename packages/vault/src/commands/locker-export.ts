// Plaintext export (GAPS §3.3 #7). A COMMAND, NOT A QUERY, twice over: a query
// handler is read-only by directive so it cannot write the receipt a mass
// reveal owes, and a replica read returns sealed columns as placeholders.
//
// `confirm: true` parks it for the owner on any non-owner device; the action
// is ONLINE-ONLY because a secret never enters the durable offline queue.

import type { Gateway } from "../gateway/gateway.js";
import type { CommandDefinition, HandlerCtx } from "../gateway/types.js";
import { LOCKER_ITEM_TYPE } from "./locker-shared.js";
import {
  LOCKER_FIELD_TYPE,
  LOCKER_HISTORY_TYPE,
  LOCKER_PASSKEY_TYPE,
  addressRows,
  fieldRows,
} from "./locker-sidecars.js";

const SEALED_ITEM_COLUMNS = [
  "password",
  "otp_seed",
  "card_number",
  "cvv",
  "content",
] as const;

const PLAIN_ITEM_COLUMNS = [
  "type",
  "title",
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
  "compromised",
  "password_set_at",
  "created_at",
  "updated_at",
  "archived_at",
  "deleted_at",
] as const;

function exportItem(
  ctx: HandlerCtx,
  row: Record<string, unknown>,
  includeHistory: boolean
): Record<string, unknown> {
  const itemId = String(row.item_id);
  const item: Record<string, unknown> = { item_id: itemId };
  for (const column of PLAIN_ITEM_COLUMNS) item[column] = row[column] ?? null;
  for (const column of SEALED_ITEM_COLUMNS) {
    item[column] = ctx.unseal(LOCKER_ITEM_TYPE, itemId, column);
  }
  item.alias =
    (
      ctx.db
        .prepare("SELECT alias FROM locker_item_alias WHERE item_id = ?")
        .get(itemId) as { alias: string } | undefined
    )?.alias ?? null;
  item.addresses = addressRows(ctx, itemId).map((address) => ({
    url: address.url,
    match_policy: address.match_policy,
  }));
  item.fields = fieldRows(ctx, itemId).map((field) => ({
    section: field.section,
    label: field.label,
    kind: field.kind,
    value:
      field.kind === "sealed"
        ? ctx.unseal(LOCKER_FIELD_TYPE, field.field_id, "value_sealed")
        : field.value_text,
  }));
  const passkey = ctx.db
    .prepare(
      `SELECT rp_id, user_handle, display_name, credential_id, algorithm, created_at
         FROM locker_item_passkey WHERE item_id = ?`
    )
    .get(itemId) as Record<string, unknown> | undefined;
  item.passkey = passkey
    ? {
        ...passkey,
        private_key: ctx.unseal(LOCKER_PASSKEY_TYPE, itemId, "private_key"),
      }
    : null;
  item.history = includeHistory
    ? (
        ctx.db
          .prepare(
            `SELECT revision_id, operation, title, changed_json, recorded_at
               FROM locker_item_history WHERE item_id = ?
              ORDER BY recorded_at DESC, revision_id DESC`
          )
          .all(itemId) as Record<string, unknown>[]
      ).map((revision) => ({
        ...revision,
        password: ctx.unseal(
          LOCKER_HISTORY_TYPE,
          String(revision.revision_id),
          "password"
        ),
      }))
    : [];
  return item;
}

const EXPORT: CommandDefinition = {
  name: "locker.export",
  ownerSchema: "locker",
  inputSchema: {
    type: "object",
    required: ["confirm"],
    additionalProperties: false,
    properties: {
      confirm: { type: "boolean", const: true },
      include_trashed: { type: "boolean" },
      include_history: { type: "boolean" },
    },
  },
  outputSchema: {
    type: "object",
    required: ["exported_at", "item_count", "items"],
    properties: {
      exported_at: { type: "string" },
      item_count: { type: "number" },
      items: { type: "array" },
    },
  },
  // The gate is the schema const plus the `confirm` flag, not a SQL
  // precondition: a precondition binds parameters as strings, so a boolean
  // read back through one would be theatre.
  preconditions: [],
  postconditions: [],
  idempotency: "retry-safe",
  risk: "high",
  confirm: true,
  // `ctx.unseal` refuses anything absent from this list.
  unseals: [
    ...SEALED_ITEM_COLUMNS.map((column) => `${LOCKER_ITEM_TYPE}.${column}`),
    `${LOCKER_FIELD_TYPE}.value_sealed`,
    `${LOCKER_PASSKEY_TYPE}.private_key`,
    `${LOCKER_HISTORY_TYPE}.password`,
  ],
  // The result IS the plaintext: redacted from the journal so the trail is
  // not a second copy of it.
  transcriptSensitive: true,
  handler: (ctx) => {
    const input = ctx.input as {
      include_trashed?: boolean;
      include_history?: boolean;
    };
    const rows = ctx.db
      .prepare(
        `SELECT * FROM locker_item
          ${input.include_trashed ? "" : "WHERE deleted_at IS NULL"}
          ORDER BY created_at, item_id`
      )
      .all() as Record<string, unknown>[];
    const items = rows.map((row) =>
      exportItem(ctx, row, input.include_history === true)
    );
    ctx.cite({
      claim: `${items.length} locker items exported in the clear`,
      entityType: LOCKER_ITEM_TYPE,
      entityId: "export",
    });
    return { exported_at: ctx.now, item_count: items.length, items };
  },
};

export function registerLockerExportCommand(gateway: Gateway): void {
  gateway.registerCommand(EXPORT);
}
