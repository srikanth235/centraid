// EVERY WRITE LOCKER ISSUES, as a value (README-Locker §2, row "Writes").
//
// THE ONE RULE THIS FILE EXISTS TO MAKE STRUCTURAL: creating or editing a
// SECRET is online only. A secret value must never enter the durable offline
// queue, so `add-item` and `edit-item` carry `onlineOnly: true` here — at the
// point the payload is built, not at the call site — while the metadata acts
// (star, unstar, trash, restore, purge) carry nothing and queue like any other
// write. `apps/locker/pending-projection.ts` states the same partition from
// the replica's side; these two are the whole of it.
//
// Pure: nothing here touches `window.centraid`. The orchestrator's one `act()`
// door takes these values and publishes their outcome on the ONE status line.

import type { LockerItemType, UrlMatchPolicy } from "./types.ts";

/** A write, exactly as `window.centraid.write` takes it. */
export interface LockerWrite {
  action: string;
  input: Record<string, unknown>;
  /** Present only where the payload can carry a secret value. */
  onlineOnly?: true;
}

/** The actions whose payload can carry a secret, and which therefore refuse to
 *  queue. Exported so a caller can state the refusal in a lede rather than
 *  discovering it at commit.
 *
 *  #872 adds three. `set-field` and `set-passkey` carry a sealed value in the
 *  payload, exactly like add and edit. `export` carries nothing INTO the
 *  vault, but its RESULT is every secret the locker holds — a mass reveal is
 *  the one thing that must never be queued for later, replayed, or answered
 *  from a device's durable store, so it takes the same door. */
export const ONLINE_ONLY_ACTIONS: readonly string[] = [
  "add-item",
  "edit-item",
  "set-field",
  "set-passkey",
  "export",
];

/** Does this write need the gateway? */
export function needsGateway(write: LockerWrite): boolean {
  return write.onlineOnly === true;
}

/** What the add / edit screen hands back. */
export interface ItemDraft {
  /** Present on an edit, absent on a create. */
  itemId?: string;
  type: LockerItemType;
  title: string;
  /** Comma-separated, as the field takes it. */
  tags: string;
  /** The connector alias, as the form holds it. On an EDIT a blank one is the
   *  member clearing the binding — `locker.edit_item` reads an empty alias as
   *  a clear — which is what closes the paper cut README-Locker §8 names. On a
   *  CREATE there is nothing to clear, so a blank one is dropped. */
  alias?: string;
  urlMatchPolicy?: UrlMatchPolicy;
  /** The type's own fields, by action key. */
  fields: Readonly<Record<string, string>>;
  /** Which of those keys belong to the chosen type. The backend drops the
   *  rest too; the payload is kept clean so nothing travels that was not
   *  asked for. */
  allowedKeys: readonly string[];
}

/** The tags field, as the action's array. */
export function tagList(tags: string): string[] {
  return tags
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/** The half of an item payload that both add and edit share. `clearsAlias` is
 *  true only on an edit: there, a blank alias is an instruction, and on a
 *  create it is only an empty field. */
function itemPayload(
  draft: ItemDraft,
  clearsAlias = false
): Record<string, unknown> {
  const allowed = new Set(draft.allowedKeys);
  const input: Record<string, unknown> = {
    title: draft.title.trim(),
    tags: tagList(draft.tags),
  };
  if (draft.type === "login" && draft.urlMatchPolicy) {
    input.url_match_policy = draft.urlMatchPolicy;
  }
  for (const [key, value] of Object.entries(draft.fields)) {
    if (allowed.has(key) && value != null && value !== "") input[key] = value;
  }
  const alias = draft.alias == null ? null : draft.alias.trim();
  if (alias !== null && (alias !== "" || clearsAlias)) input.alias = alias;
  return input;
}

/** Create an item. ONLINE ONLY — the payload can carry a secret. */
export function addItemWrite(draft: ItemDraft): LockerWrite {
  return {
    action: "add-item",
    input: { type: draft.type, ...itemPayload(draft) },
    onlineOnly: true,
  };
}

/** Rewrite an item. ONLINE ONLY — the payload can carry a secret. */
export function editItemWrite(
  draft: ItemDraft & { itemId: string }
): LockerWrite {
  return {
    action: "edit-item",
    input: { item_id: draft.itemId, ...itemPayload(draft, true) },
    onlineOnly: true,
  };
}

/** The product-wide star. Metadata: it queues. */
export function starWrite(itemId: string, starred: boolean): LockerWrite {
  return {
    action: starred ? "unstar-item" : "star-item",
    input: { item_id: itemId },
  };
}

/** Thirty days, with its star and its tags. Metadata: it queues. */
export function trashWrite(itemId: string): LockerWrite {
  return { action: "trash-item", input: { item_id: itemId } };
}

/** The true reverse of a trash — which is why trashing is the one act in this
 *  app that offers Undo. Metadata: it queues. */
export function restoreWrite(itemId: string): LockerWrite {
  return { action: "restore-item", input: { item_id: itemId } };
}

/** Irreversible, confirmed, and parked off-owner by the vault itself.
 *  Metadata: it queues. */
export function purgeWrite(itemId: string): LockerWrite {
  return { action: "purge-item", input: { item_id: itemId } };
}

/** "Keep forever, hide from lists" — the opposite end of trash's countdown.
 *  Metadata: it queues. */
export function archiveWrite(itemId: string, archived: boolean): LockerWrite {
  return {
    action: archived ? "unarchive-item" : "archive-item",
    input: { item_id: itemId },
  };
}

/** Clone-and-edit for a sibling account. The sealed values are copied inside
 *  the vault, so nothing secret rides this payload — it queues. */
export function duplicateWrite(itemId: string): LockerWrite {
  return { action: "duplicate-item", input: { item_id: itemId } };
}

/** One custom field. ONLINE ONLY — a `sealed` kind carries a secret. */
export function setFieldWrite(
  itemId: string,
  field: {
    fieldId?: string;
    section?: string;
    label: string;
    kind: string;
    value?: string;
    position?: number;
  }
): LockerWrite {
  return {
    action: "set-field",
    input: {
      item_id: itemId,
      label: field.label,
      kind: field.kind,
      ...(field.fieldId ? { field_id: field.fieldId } : {}),
      ...(field.section == null ? {} : { section: field.section }),
      ...(field.value == null ? {} : { value: field.value }),
      ...(field.position == null ? {} : { position: field.position }),
    },
    onlineOnly: true,
  };
}

/** Drop a custom field. Metadata: it queues. */
export function removeFieldWrite(itemId: string, fieldId: string): LockerWrite {
  return {
    action: "remove-field",
    input: { item_id: itemId, field_id: fieldId },
  };
}

/** The additional addresses, as a set. No secret: it queues. */
export function setAddressesWrite(
  itemId: string,
  addresses: readonly { url: string; matchPolicy?: UrlMatchPolicy }[]
): LockerWrite {
  return {
    action: "set-addresses",
    input: {
      item_id: itemId,
      addresses: addresses.map((address) => ({
        url: address.url,
        match_policy: address.matchPolicy ?? "registrable-domain",
      })),
    },
  };
}

/** The passkey slot. ONLINE ONLY — key material is a secret. */
export function setPasskeyWrite(
  itemId: string,
  passkey: {
    rpId: string;
    userHandle?: string;
    displayName?: string;
    credentialId?: string;
    algorithm?: string;
    privateKey?: string;
  }
): LockerWrite {
  return {
    action: "set-passkey",
    input: {
      item_id: itemId,
      rp_id: passkey.rpId,
      ...(passkey.userHandle ? { user_handle: passkey.userHandle } : {}),
      ...(passkey.displayName ? { display_name: passkey.displayName } : {}),
      ...(passkey.credentialId ? { credential_id: passkey.credentialId } : {}),
      ...(passkey.algorithm ? { algorithm: passkey.algorithm } : {}),
      ...(passkey.privateKey ? { private_key: passkey.privateKey } : {}),
    },
    onlineOnly: true,
  };
}

/** Metadata and sealed key material together. It queues. */
export function clearPasskeyWrite(itemId: string): LockerWrite {
  return { action: "clear-passkey", input: { item_id: itemId } };
}

/**
 * The plaintext export. ONLINE ONLY, and the one write in this app whose
 * RESULT is the secret rather than its input — "This writes every title,
 * username, address, note and password to a plaintext file on this device."
 * `confirm` is not defaulted anywhere: the command's own schema refuses
 * anything but a literal true, so the consequence has to be said out loud.
 */
export function exportWrite(options: {
  includeTrashed?: boolean;
  includeHistory?: boolean;
}): LockerWrite {
  return {
    action: "export",
    input: {
      confirm: true,
      ...(options.includeTrashed ? { include_trashed: true } : {}),
      ...(options.includeHistory ? { include_history: true } : {}),
    },
    onlineOnly: true,
  };
}
