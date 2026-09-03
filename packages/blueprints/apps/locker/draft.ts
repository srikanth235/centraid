import type { ItemDraftSeed, LockerDetail, LockerItemType } from "./types.ts";
import type { ItemDraft } from "./writes.ts";

export const SEALED = "«sealed»";

export type DraftFieldKind = "text" | "secret" | "long" | "otp";

export interface DraftField {
  key: string;
  label: string;
  kind: DraftFieldKind;
  note?: string;
  numeric?: boolean;
}

export const SEALED_KEYS: ReadonlySet<string> = new Set([
  "password",
  "otp_seed",
  "card_number",
  "cvv",
  "content",
]);

const TEMPLATE_ONLY: readonly DraftField[] = [
  { key: "notes", label: "Memo", kind: "long" },
];

export const TYPE_FIELDS: Readonly<
  Record<LockerItemType, readonly DraftField[]>
> = {
  login: [
    { key: "username", label: "Username", kind: "text" },
    { key: "password", label: "Password", kind: "secret" },
    { key: "url", label: "Address", kind: "text" },
    { key: "otp_seed", label: "One-time code", kind: "otp" },
    { key: "notes", label: "Memo", kind: "long" },
  ],
  card: [
    { key: "cardholder", label: "Cardholder", kind: "text" },
    { key: "card_number", label: "Card number", kind: "secret", numeric: true },
    { key: "expiry", label: "Expiry", kind: "text", numeric: true },
    { key: "cvv", label: "Security code", kind: "secret", numeric: true },
    { key: "brand", label: "Brand", kind: "text" },
    { key: "notes", label: "Memo", kind: "long" },
  ],
  note: [
    { key: "content", label: "Note", kind: "long" },
    { key: "notes", label: "Memo", kind: "long" },
  ],
  identity: [
    { key: "fullname", label: "Name", kind: "text" },
    { key: "email", label: "Email", kind: "text" },
    { key: "phone", label: "Phone", kind: "text" },
    { key: "address", label: "Address", kind: "text" },
    { key: "notes", label: "Memo", kind: "long" },
  ],
  wifi: [
    { key: "network", label: "Network", kind: "text" },
    { key: "password", label: "Network password", kind: "secret" },
    { key: "notes", label: "Memo", kind: "long" },
  ],
  password: [
    { key: "password", label: "Password", kind: "secret" },
    { key: "notes", label: "Memo", kind: "long" },
  ],
  ssh_key: TEMPLATE_ONLY,
  api_credential: TEMPLATE_ONLY,
  passport: TEMPLATE_ONLY,
  bank_account: TEMPLATE_ONLY,
  driving_licence: TEMPLATE_ONLY,
  software_licence: TEMPLATE_ONLY,
  crypto_wallet: TEMPLATE_ONLY,
  membership: TEMPLATE_ONLY,
  document: TEMPLATE_ONLY,
};

export function isSealedField(field: DraftField): boolean {
  return SEALED_KEYS.has(field.key);
}

export function fieldsFor(type: LockerItemType): readonly DraftField[] {
  return TYPE_FIELDS[type] ?? TYPE_FIELDS.note;
}

export function allowedKeys(type: LockerItemType): string[] {
  return fieldsFor(type).map((field) => field.key);
}

export function carriesMatchPolicy(type: LockerItemType): boolean {
  return type === "login";
}

export function emptySeed(type: LockerItemType = "login"): ItemDraftSeed {
  return {
    mode: "new",
    type,
    title: "",
    tags: "",
    alias: "",
    urlMatchPolicy: "registrable-domain",
    fields: {},
  };
}

export function seedFromDetail(detail: LockerDetail): ItemDraftSeed {
  const fields: Record<string, string> = {};
  for (const field of fieldsFor(detail.type)) {
    if (isSealedField(field)) {
      const held = (detail as unknown as Record<string, unknown>)[field.key];
      if (held != null && held !== "") fields[field.key] = SEALED;
      continue;
    }
    const value = (detail as unknown as Record<string, unknown>)[field.key];
    if (typeof value === "string" && value !== "") fields[field.key] = value;
  }
  return {
    mode: "edit",
    itemId: detail.item_id,
    type: detail.type,
    title: detail.title,
    tags: (detail.tags ?? []).join(", "),
    alias: detail.alias ?? "",
    urlMatchPolicy: detail.url_match_policy ?? "registrable-domain",
    fields,
  };
}

export function retype(
  seed: ItemDraftSeed,
  type: LockerItemType
): ItemDraftSeed {
  const keep = new Set(allowedKeys(type));
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(seed.fields)) {
    if (keep.has(key)) fields[key] = value;
  }
  return { ...seed, type, fields };
}

export function isReady(seed: ItemDraftSeed): boolean {
  return seed.title.trim().length > 0;
}

export function draftFrom(seed: ItemDraftSeed): ItemDraft {
  return {
    ...(seed.itemId ? { itemId: seed.itemId } : {}),
    type: seed.type,
    title: seed.title,
    tags: seed.tags,
    alias: seed.alias,
    ...(carriesMatchPolicy(seed.type)
      ? { urlMatchPolicy: seed.urlMatchPolicy }
      : {}),
    fields: seed.fields,
    allowedKeys: allowedKeys(seed.type),
  };
}
