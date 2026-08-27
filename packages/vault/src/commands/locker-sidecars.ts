// Row helpers for Locker's sidecar tables (#872): custom fields and sections,
// extra addresses, the passkey slot, and the durable item/password history.

import type { HandlerCtx } from "../gateway/types.js";
import { SEALED_PLACEHOLDER } from "../schema/sealed.js";
import { templateFor } from "./locker-types.js";

export const LOCKER_FIELD_TYPE = "locker.item_field";
export const LOCKER_ADDRESS_TYPE = "locker.item_address";
export const LOCKER_PASSKEY_TYPE = "locker.item_passkey";
export const LOCKER_HISTORY_TYPE = "locker.item_history";

export const FIELD_KINDS = ["text", "sealed", "url", "date", "otp"] as const;

export interface FieldRow {
  field_id: string;
  item_id: string;
  section: string;
  label: string;
  kind: string;
  value_text: string | null;
  value_sealed: string | null;
  position: number;
}

export function fieldRows(ctx: HandlerCtx, itemId: string): FieldRow[] {
  return ctx.db
    .prepare(
      `SELECT field_id, item_id, section, label, kind, value_text, value_sealed, position
         FROM locker_item_field WHERE item_id = ?
        ORDER BY section, position, label`
    )
    .all(itemId) as unknown as FieldRow[];
}

export interface FieldInput {
  fieldId?: string;
  section: string;
  label: string;
  kind: string;
  value?: string | null;
  position?: number;
}

/**
 * Insert or rewrite ONE custom field. One field per call on purpose: a sealed
 * value has to be a TOP-LEVEL command input for `sealedInput` to hash it out
 * of the journal (schema/sealed.ts redacts top-level paths only).
 *
 * A rewrite keeps its `field_id`, which is what lets the round-tripped
 * `«sealed»` placeholder mean "unchanged": the ciphertext's AAD is bound to
 * that id.
 */
export function writeField(
  ctx: HandlerCtx,
  itemId: string,
  input: FieldInput
): string {
  const existing = input.fieldId
    ? (ctx.db
        .prepare(
          `SELECT field_id, value_sealed, value_text, created_at
             FROM locker_item_field WHERE field_id = ? AND item_id = ?`
        )
        .get(input.fieldId, itemId) as
        | {
            field_id: string;
            value_sealed: string | null;
            value_text: string | null;
            created_at: string;
          }
        | undefined)
    : undefined;
  if (input.fieldId && !existing)
    throw new Error(`no custom field ${input.fieldId} on this item`);
  const fieldId = existing?.field_id ?? ctx.newId();
  const sealed = input.kind === "sealed";
  const supplied =
    input.value == null || input.value === "" ? null : String(input.value);
  const unchanged = supplied === SEALED_PLACEHOLDER;
  const valueSealed = sealed
    ? unchanged
      ? (existing?.value_sealed ?? null)
      : supplied
    : null;
  const valueText = sealed ? null : unchanged ? existing?.value_text : supplied;
  ctx.db
    .prepare(
      `INSERT INTO locker_item_field
         (field_id, item_id, section, label, kind, value_text, value_sealed,
          position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(field_id) DO UPDATE SET
         section = excluded.section,
         label = excluded.label,
         kind = excluded.kind,
         value_text = excluded.value_text,
         value_sealed = excluded.value_sealed,
         position = excluded.position,
         updated_at = excluded.updated_at`
    )
    .run(
      fieldId,
      itemId,
      input.section,
      input.label,
      input.kind,
      valueText ?? null,
      valueSealed,
      input.position ?? 0,
      existing?.created_at ?? ctx.now,
      ctx.now
    );
  // The seal sweep runs off this write marker: `value_sealed` is ciphertext
  // before the transaction commits.
  ctx.wrote(LOCKER_FIELD_TYPE, fieldId);
  return fieldId;
}

export function mintTemplateFields(
  ctx: HandlerCtx,
  itemId: string,
  type: string
): number {
  const template = templateFor(type);
  template.forEach((field, index) => {
    writeField(ctx, itemId, {
      section: field.section,
      label: field.label,
      kind: field.kind,
      position: index,
    });
  });
  return template.length;
}

export interface AddressInput {
  url: string;
  matchPolicy?: string;
}

/** `locker_item.url` stays the primary, so Companion candidates, the connector
 *  binding and Review's unsecured-address check keep working. No secret is
 *  involved, which is why this one takes the whole list. */
export function setAddresses(
  ctx: HandlerCtx,
  itemId: string,
  addresses: readonly AddressInput[]
): number {
  ctx.db
    .prepare("DELETE FROM locker_item_address WHERE item_id = ?")
    .run(itemId);
  let position = 0;
  const seen = new Set<string>();
  for (const address of addresses) {
    const url = String(address.url ?? "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const addressId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO locker_item_address
           (address_id, item_id, url, match_policy, position, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        addressId,
        itemId,
        url,
        address.matchPolicy === "exact-host"
          ? "exact-host"
          : "registrable-domain",
        position,
        ctx.now
      );
    ctx.wrote(LOCKER_ADDRESS_TYPE, addressId);
    position += 1;
  }
  return position;
}

export function addressRows(
  ctx: HandlerCtx,
  itemId: string
): { address_id: string; url: string; match_policy: string }[] {
  return ctx.db
    .prepare(
      `SELECT address_id, url, match_policy FROM locker_item_address
        WHERE item_id = ? ORDER BY position, url`
    )
    .all(itemId) as {
    address_id: string;
    url: string;
    match_policy: string;
  }[];
}

export interface PasskeyInput {
  rpId: string;
  userHandle?: string | null;
  displayName?: string | null;
  credentialId?: string | null;
  algorithm?: string | null;
  privateKey?: string | null;
}

/** Storage only — no WebAuthn ceremony. */
export function writePasskey(
  ctx: HandlerCtx,
  itemId: string,
  input: PasskeyInput
): void {
  const existing = ctx.db
    .prepare(
      "SELECT private_key, created_at FROM locker_item_passkey WHERE item_id = ?"
    )
    .get(itemId) as
    | { private_key: string | null; created_at: string }
    | undefined;
  const supplied =
    input.privateKey == null || input.privateKey === ""
      ? null
      : String(input.privateKey);
  const privateKey =
    supplied === SEALED_PLACEHOLDER
      ? (existing?.private_key ?? null)
      : supplied;
  ctx.db
    .prepare(
      `INSERT INTO locker_item_passkey
         (item_id, rp_id, user_handle, display_name, credential_id, algorithm,
          private_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET
         rp_id = excluded.rp_id,
         user_handle = excluded.user_handle,
         display_name = excluded.display_name,
         credential_id = excluded.credential_id,
         algorithm = excluded.algorithm,
         private_key = excluded.private_key,
         updated_at = excluded.updated_at`
    )
    .run(
      itemId,
      input.rpId,
      input.userHandle ?? null,
      input.displayName ?? null,
      input.credentialId ?? null,
      input.algorithm ?? null,
      privateKey,
      existing?.created_at ?? ctx.now,
      ctx.now
    );
  ctx.wrote(LOCKER_PASSKEY_TYPE, itemId);
}

/** `password` arrives as PLAINTEXT and is sealed by the sweep against THIS
 *  row's id — copying the item's ciphertext would bind it to the wrong cell
 *  (the AAD is `table.column:rowid`). */
export function recordHistory(
  ctx: HandlerCtx,
  itemId: string,
  input: {
    operation: string;
    title?: string | null;
    previousPassword?: string | null;
    changed: Record<string, unknown>;
  }
): string {
  const revisionId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO locker_item_history
         (revision_id, item_id, operation, title, password, changed_json, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      revisionId,
      itemId,
      input.operation,
      input.title ?? null,
      input.previousPassword ?? null,
      JSON.stringify(input.changed),
      ctx.now
    );
  ctx.wrote(LOCKER_HISTORY_TYPE, revisionId);
  return revisionId;
}
