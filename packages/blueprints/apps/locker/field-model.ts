// The owner-defined and template-minted rows of `item.fields[]` (README-Locker
// §3); `draft.ts` holds the column-backed half. THE SEALED HALF NEVER CARRIES
// A VALUE — `sealed: true`, `value: null`, and nothing here turns a presence
// into a plaintext.

import { DAY_MS } from "../_shared/format-kit.ts";
import { HISTORY_PASSWORD_LABEL, PASSKEY_KEY_ROW } from "./item-copy.ts";
import type { SidecarTarget } from "./permits.ts";
import type {
  LockerCustomField,
  LockerDetail,
  LockerItemType,
} from "./types.ts";

export const FIELD_KINDS: readonly LockerCustomField["kind"][] = [
  "text",
  "sealed",
  "url",
  "date",
  "otp",
];

export const KIND_LABEL: Readonly<Record<string, string>> = {
  text: "Text",
  sealed: "Sealed",
  url: "Address",
  date: "Date",
  otp: "One-time code",
};

export const DEFAULT_SECTION = "Fields";

export interface FieldSection {
  section: string;
  fields: LockerCustomField[];
}

/** Insertion order is the vault's order; a second sort is a second answer. */
export function sectionsOf(
  fields: readonly LockerCustomField[] | undefined
): FieldSection[] {
  const sections = new Map<string, LockerCustomField[]>();
  for (const field of fields ?? []) {
    const key = field.section || DEFAULT_SECTION;
    const bucket = sections.get(key);
    if (bucket) bucket.push(field);
    else sections.set(key, [field]);
  }
  return [...sections.entries()].map(([section, own]) => ({
    section,
    fields: own,
  }));
}

/** Two sealed rows on ONE item must never share a key — `permitCovers`
 *  compares keys, so the row's id, never its label, namespaces them. */
export function sealedFieldKey(fieldId: string): string {
  return `field:${fieldId}`;
}
export function historyPasswordKey(revisionId: string): string {
  return `history:${revisionId}`;
}
export const PASSKEY_KEY_FIELD = "passkey";

export interface SidecarAsk {
  target: SidecarTarget;
  label: string;
}

/** An ADDRESS, never a value. An unknown key resolves to null rather than to
 *  a guess: a permit nobody could spend. */
export function sidecarAskOf(
  field: string,
  detail: LockerDetail | null | undefined
): SidecarAsk | null {
  if (!detail) return null;
  if (field === PASSKEY_KEY_FIELD) {
    return detail.passkey?.has_private_key
      ? {
          target: {
            entity: "locker.item_passkey",
            entityId: detail.item_id,
            column: "private_key",
          },
          label: PASSKEY_KEY_ROW,
        }
      : null;
  }
  if (field.startsWith("field:")) {
    const fieldId = field.slice("field:".length);
    const own = (detail.fields ?? []).find((row) => row.field_id === fieldId);
    if (!own || own.kind !== "sealed") return null;
    return {
      target: {
        entity: "locker.item_field",
        entityId: fieldId,
        column: "value_sealed",
      },
      label: own.label,
    };
  }
  if (field.startsWith("history:")) {
    const revisionId = field.slice("history:".length);
    const revision = (detail.history ?? []).find(
      (row) => row.revision_id === revisionId
    );
    if (!revision?.has_previous_password) return null;
    return {
      target: {
        entity: "locker.item_history",
        entityId: revisionId,
        column: "password",
      },
      label: HISTORY_PASSWORD_LABEL,
    };
  }
  return null;
}

export function hasFields(detail: LockerDetail): boolean {
  return (detail.fields ?? []).length > 0;
}

export function degradationCopy(
  degradedFrom: string | null | undefined
): string | null {
  if (!degradedFrom) return null;
  return `Stored as ${degradedFrom}, which this build does not draw · a type is a set of sections and fields, so one the vault does not have yet degrades to a note with custom fields rather than to nothing.`;
}

export function byteSize(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `changed` lists column NAMES, never values — a history records that a
 *  rotation happened, not what it rotated. */
export function changedWords(
  changed: Record<string, unknown> | undefined
): string {
  const keys = Object.keys(changed ?? {});
  if (keys.length === 0) return "";
  return keys.map((key) => key.replaceAll("_", " ")).join(", ");
}

export function passwordAge(
  setAt: string | null | undefined,
  now: number
): string {
  if (!setAt) return "";
  const days = Math.floor((now - new Date(setAt).getTime()) / DAY_MS);
  if (!Number.isFinite(days) || days < 0) return "";
  if (days === 0) return "set today";
  if (days === 1) return "set yesterday";
  if (days < 365) return `set ${days} days ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? "set over a year ago" : `set over ${years} years ago`;
}

export function isTemplateType(type: LockerItemType): boolean {
  return !["login", "card", "note", "identity", "wifi", "password"].includes(
    type
  );
}
