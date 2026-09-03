import type { LockerDetail, LockerItemType } from "./types.ts";

export interface SealedFieldRow {
  field: string;
  label: string;
  note?: string;
}

export interface MetadataFieldRow {
  label: string;
  value: string;
  copy?: string;
}

export function sealedFieldsFor(
  type: LockerItemType | string
): readonly SealedFieldRow[] {
  if (type === "card") {
    return [
      { field: "card_number", label: "Card number" },
      {
        field: "cvv",
        label: "Security code",
        note: "Three digits, sealed like any other secret.",
      },
    ];
  }
  if (type === "note") {
    return [
      {
        field: "content",
        label: "Note",
        note: "Sealed at rest, and deliberately not searched — a note routinely holds recovery codes.",
      },
    ];
  }
  if (type === "wifi") {
    return [
      {
        field: "password",
        label: "Network password",
        note: "Sealed · the network name is not.",
      },
    ];
  }
  if (type === "identity") return [];
  return [{ field: "password", label: "Password" }];
}

export function metadataFieldsFor(
  detail: LockerDetail
): readonly MetadataFieldRow[] {
  const rows: MetadataFieldRow[] = [];
  if (detail.username) {
    rows.push({ label: "Username", value: detail.username, copy: "Username" });
  }
  if (detail.type === "identity") {
    if (detail.fullname) rows.push({ label: "Name", value: detail.fullname });
    if (detail.email) {
      rows.push({ label: "Email", value: detail.email, copy: "Email" });
    }
    if (detail.phone) rows.push({ label: "Phone", value: detail.phone });
    if (detail.address) rows.push({ label: "Address", value: detail.address });
  }
  if (detail.type === "card") {
    if (detail.cardholder) {
      rows.push({ label: "Cardholder", value: detail.cardholder });
    }
    if (detail.brand) rows.push({ label: "Brand", value: detail.brand });
  }
  if (detail.type === "wifi" && detail.network) {
    rows.push({ label: "Network", value: detail.network, copy: "Network" });
  }
  return rows;
}

export const SEALED_RUN = "••••••••••••••";
