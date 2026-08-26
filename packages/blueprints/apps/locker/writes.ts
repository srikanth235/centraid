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
 *  discovering it at commit. */
export const ONLINE_ONLY_ACTIONS: readonly string[] = ["add-item", "edit-item"];

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
  /** A non-empty value sets or changes the alias; a blank one is left
   *  untouched, so an edit never clobbers an existing binding. Clearing and
   *  reassigning are the paper cuts README-Locker §8 names — a backend fix. */
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

/** The half of an item payload that both add and edit share. */
function itemPayload(draft: ItemDraft): Record<string, unknown> {
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
  const alias = (draft.alias ?? "").trim();
  if (alias) input.alias = alias;
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
    input: { item_id: draft.itemId, ...itemPayload(draft) },
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
