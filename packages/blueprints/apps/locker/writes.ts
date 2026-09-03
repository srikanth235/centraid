import type { LockerItemType, UrlMatchPolicy } from "./types.ts";

export interface LockerWrite {
  action: string;
  input: Record<string, unknown>;
  onlineOnly?: true;
}

export const ONLINE_ONLY_ACTIONS: readonly string[] = [
  "add-item",
  "edit-item",
  "set-field",
  "set-passkey",
  "export",
];

export function needsGateway(write: LockerWrite): boolean {
  return write.onlineOnly === true;
}

export interface ItemDraft {
  itemId?: string;
  type: LockerItemType;
  title: string;
  tags: string;
  alias?: string;
  urlMatchPolicy?: UrlMatchPolicy;
  fields: Readonly<Record<string, string>>;
  allowedKeys: readonly string[];
}

export function tagList(tags: string): string[] {
  return tags
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

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

export function addItemWrite(draft: ItemDraft): LockerWrite {
  return {
    action: "add-item",
    input: { type: draft.type, ...itemPayload(draft) },
    onlineOnly: true,
  };
}

export function editItemWrite(
  draft: ItemDraft & { itemId: string }
): LockerWrite {
  return {
    action: "edit-item",
    input: { item_id: draft.itemId, ...itemPayload(draft, true) },
    onlineOnly: true,
  };
}

export function starWrite(itemId: string, starred: boolean): LockerWrite {
  return {
    action: starred ? "unstar-item" : "star-item",
    input: { item_id: itemId },
  };
}

export function trashWrite(itemId: string): LockerWrite {
  return { action: "trash-item", input: { item_id: itemId } };
}

export function restoreWrite(itemId: string): LockerWrite {
  return { action: "restore-item", input: { item_id: itemId } };
}

export function purgeWrite(itemId: string): LockerWrite {
  return { action: "purge-item", input: { item_id: itemId } };
}

export function archiveWrite(itemId: string, archived: boolean): LockerWrite {
  return {
    action: archived ? "unarchive-item" : "archive-item",
    input: { item_id: itemId },
  };
}

export function duplicateWrite(itemId: string): LockerWrite {
  return { action: "duplicate-item", input: { item_id: itemId } };
}

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

export function removeFieldWrite(itemId: string, fieldId: string): LockerWrite {
  return {
    action: "remove-field",
    input: { item_id: itemId, field_id: fieldId },
  };
}

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

export function clearPasskeyWrite(itemId: string): LockerWrite {
  return { action: "clear-passkey", input: { item_id: itemId } };
}

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
