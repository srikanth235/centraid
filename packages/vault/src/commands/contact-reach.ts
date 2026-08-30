// The ONE contact-reach module (#883 O-contact). AN IDENTIFIER IS NOT A
// CHANNEL: a key someone IS (DID, site, IBAN, claimed handle) lives in
// `core_party_identifier`; an address they can be REACHED at lives in
// `social_contact_channel`. They differ on dedupe, display and sharing, so
// reach needs one normalization every reader agrees on.

import type { DatabaseSync } from "node:sqlite";

export type ChannelKind = "phone" | "email" | "address" | "handle";

// `handle` is deliberately absent: only the CALL SITE knows whether a handle is
// reach or a claimed identity key.
export const REACH_SCHEME_KIND: Readonly<Record<string, ChannelKind>> = {
  email: "email",
  tel: "phone",
  phone: "phone",
};

export function reachKindOf(scheme: string): ChannelKind | undefined {
  return REACH_SCHEME_KIND[scheme];
}

// Never throws — an imported address is still an address. Member-facing
// validation is a command-input concern, in `normalizeContactChannel`.
export function contactReachKey(kind: ChannelKind, rawValue: string): string {
  const value = rawValue.trim();
  if (kind === "email") return value.toLocaleLowerCase("en-US");
  if (kind === "phone") {
    // Rung seven's SQL carries this exact rule, so a migrated identifier and
    // a typed number land on one key.
    const prefix = value.startsWith("+") ? "+" : "";
    return `${prefix}${value.replace(/[\s().-]/gu, "").replace(/^\+/u, "")}`;
  }
  if (kind === "handle")
    return value.replace(/^@/u, "").toLocaleLowerCase("en-US");
  return value
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("en-US");
}

export function normalizeContactChannel(
  kind: ChannelKind,
  rawValue: string
): string {
  const normalized = contactReachKey(kind, rawValue);
  if (kind === "email") {
    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized) ||
      normalized.length > 320
    )
      throw new Error("enter a valid email address");
    return normalized;
  }
  if (kind === "phone") {
    if (!/^\+?\d{7,15}$/u.test(normalized))
      throw new Error("enter a phone number with 7 to 15 digits");
    return normalized;
  }
  if (kind === "handle") {
    if (
      normalized.length < 2 ||
      normalized.length > 100 ||
      !/^[\p{L}\p{N}._:@/-]+$/u.test(normalized)
    )
      throw new Error("enter a valid handle");
    return normalized;
  }
  if (normalized.length < 3 || normalized.length > 500)
    throw new Error("enter a complete address");
  return normalized;
}

// `null` only for an identity scheme: the caller falls through to the register.
export function bindContactReach(
  vault: DatabaseSync,
  binding: {
    channelId: string;
    partyId: string;
    scheme: string;
    value: string;
    label?: string | null;
    provenanceJson?: string | null;
    now: string;
  }
): string | null {
  const kind = reachKindOf(binding.scheme);
  if (!kind) return null;
  const normalized = contactReachKey(kind, binding.value);
  const existing = vault
    .prepare(
      `SELECT channel_id FROM social_contact_channel
        WHERE party_id = ? AND kind = ? AND normalized_value = ?`
    )
    .get(binding.partyId, kind, normalized) as
    | { channel_id: string }
    | undefined;
  if (existing) return existing.channel_id;
  const hasPreferred = vault
    .prepare(
      `SELECT 1 AS x FROM social_contact_channel
        WHERE party_id = ? AND kind = ? AND is_preferred = 1`
    )
    .get(binding.partyId, kind);
  vault
    .prepare(
      `INSERT INTO social_contact_channel
        (channel_id, party_id, kind, label, value, normalized_value,
         is_preferred, provenance_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      binding.channelId,
      binding.partyId,
      kind,
      binding.label ?? null,
      binding.value.trim(),
      normalized,
      hasPreferred ? 0 : 1,
      binding.provenanceJson ?? null,
      binding.now,
      binding.now
    );
  return binding.channelId;
}

export function partyForReach(
  vault: DatabaseSync,
  scheme: string | null,
  value: string,
  now: string
): string | null {
  const kinds = scheme
    ? [reachKindOf(scheme)].filter((kind): kind is ChannelKind => kind != null)
    : (["email", "phone", "handle", "address"] as ChannelKind[]);
  for (const kind of kinds) {
    const row = vault
      .prepare(
        `SELECT party_id FROM social_contact_channel
          WHERE kind = ? AND normalized_value = ?
          ORDER BY is_preferred DESC, channel_id LIMIT 1`
      )
      .get(kind, contactReachKey(kind, value)) as
      | { party_id: string }
      | undefined;
    if (row) return row.party_id;
  }
  if (scheme != null && reachKindOf(scheme)) return null;
  const row = vault
    .prepare(
      `SELECT party_id FROM core_party_identifier
        WHERE ${scheme == null ? "1 = 1" : "scheme = :scheme"}
          AND value = :value AND (valid_to IS NULL OR valid_to > :now)
        ORDER BY is_primary DESC LIMIT 1`
    )
    .get(scheme == null ? { value, now } : { scheme, value, now }) as
    | { party_id: string }
    | undefined;
  return row?.party_id ?? null;
}

// Deliberately NOT a merge: `core.merge_party` (#290) re-points every FK.
export function duplicatePartyIds(
  vault: DatabaseSync,
  partyId: string,
  kind: ChannelKind,
  normalized: string
): string[] {
  return (
    vault
      .prepare(
        `SELECT DISTINCT party_id FROM social_contact_channel
          WHERE kind = ? AND normalized_value = ? AND party_id <> ?
          ORDER BY party_id`
      )
      .all(kind, normalized, partyId) as Array<{ party_id: string }>
  ).map((row) => row.party_id);
}

export interface ContactReachRow {
  kind: ChannelKind;
  value: string;
  normalizedValue: string;
  label: string | null;
}

export function contactReach(
  vault: DatabaseSync,
  partyId: string,
  kinds: readonly ChannelKind[]
): ContactReachRow[] {
  const placeholders = kinds.map(() => "?").join(", ");
  return (
    vault
      .prepare(
        `SELECT kind, value, normalized_value, label
           FROM social_contact_channel
          WHERE party_id = ? AND kind IN (${placeholders})
          ORDER BY kind, is_preferred DESC, channel_id`
      )
      .all(partyId, ...kinds) as {
      kind: ChannelKind;
      value: string;
      normalized_value: string;
      label: string | null;
    }[]
  ).map((row) => ({
    kind: row.kind,
    value: row.value,
    normalizedValue: row.normalized_value,
    label: row.label,
  }));
}
