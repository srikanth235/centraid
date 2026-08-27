// Locker item types as SETS OF SECTIONS AND FIELDS (GAPS §3.3 #1). The six
// original types own nullable columns on `locker_item`; the nine this module
// adds own NO columns — a type is a template of custom fields minted into
// `locker_item_field` on create, and a `sealed` field lands in that table's
// sealed column like any other secret.
//
// DEGRADATION (README-Locker §3) falls out of that: an unrecognised type loses
// only its chip label. The rule is READ-side; this module owns the write side,
// where the DDL CHECK keeps the type honest.

export interface LockerTemplateField {
  section: string;
  label: string;
  kind: "text" | "sealed" | "url" | "date" | "otp";
}

export const LOCKER_ITEM_TYPES = [
  "login",
  "card",
  "note",
  "identity",
  "wifi",
  "password",
  "ssh_key",
  "api_credential",
  "passport",
  "bank_account",
  "driving_licence",
  "software_licence",
  "crypto_wallet",
  "membership",
  "document",
] as const;

const SEALED = "sealed" as const;
const TEXT = "text" as const;
const DATE = "date" as const;
const URL = "url" as const;

/** Sealed where the value alone is the credential; a name, issuer or expiry
 *  is metadata, and sealing it costs the browsable half for nothing. */
export const LOCKER_TYPE_TEMPLATES: Readonly<
  Record<string, readonly LockerTemplateField[]>
> = {
  ssh_key: [
    { section: "Key", label: "Private key", kind: SEALED },
    { section: "Key", label: "Key passphrase", kind: SEALED },
    { section: "Key", label: "Public key", kind: TEXT },
    { section: "Key", label: "Fingerprint", kind: TEXT },
    { section: "Host", label: "Host", kind: TEXT },
    { section: "Host", label: "User", kind: TEXT },
  ],
  api_credential: [
    { section: "Credential", label: "Key id", kind: TEXT },
    { section: "Credential", label: "Secret", kind: SEALED },
    { section: "Service", label: "Endpoint", kind: URL },
    { section: "Service", label: "Environment", kind: TEXT },
    { section: "Service", label: "Expires", kind: DATE },
  ],
  passport: [
    { section: "Document", label: "Passport number", kind: SEALED },
    { section: "Holder", label: "Full name", kind: TEXT },
    { section: "Holder", label: "Nationality", kind: TEXT },
    { section: "Holder", label: "Date of birth", kind: DATE },
    { section: "Document", label: "Issued", kind: DATE },
    { section: "Document", label: "Expires", kind: DATE },
    { section: "Document", label: "Place of issue", kind: TEXT },
  ],
  bank_account: [
    { section: "Account", label: "Account holder", kind: TEXT },
    { section: "Account", label: "Account number", kind: SEALED },
    { section: "Account", label: "Sort code or routing number", kind: SEALED },
    { section: "Account", label: "IBAN", kind: SEALED },
    { section: "Bank", label: "BIC or SWIFT", kind: TEXT },
    { section: "Bank", label: "Bank", kind: TEXT },
  ],
  driving_licence: [
    { section: "Licence", label: "Licence number", kind: SEALED },
    { section: "Holder", label: "Full name", kind: TEXT },
    { section: "Holder", label: "Date of birth", kind: DATE },
    { section: "Licence", label: "Issued", kind: DATE },
    { section: "Licence", label: "Expires", kind: DATE },
    { section: "Licence", label: "Issuing authority", kind: TEXT },
    { section: "Licence", label: "Classes", kind: TEXT },
  ],
  software_licence: [
    { section: "Licence", label: "Licence key", kind: SEALED },
    { section: "Product", label: "Product", kind: TEXT },
    { section: "Product", label: "Version", kind: TEXT },
    { section: "Licence", label: "Registered to", kind: TEXT },
    { section: "Purchase", label: "Purchased", kind: DATE },
    { section: "Licence", label: "Expires", kind: DATE },
    { section: "Purchase", label: "Order reference", kind: TEXT },
  ],
  crypto_wallet: [
    { section: "Recovery", label: "Recovery phrase", kind: SEALED },
    { section: "Keys", label: "Private key", kind: SEALED },
    { section: "Keys", label: "Wallet passphrase", kind: SEALED },
    { section: "Wallet", label: "Public address", kind: TEXT },
    { section: "Wallet", label: "Network", kind: TEXT },
    { section: "Wallet", label: "Wallet software", kind: TEXT },
  ],
  membership: [
    { section: "Membership", label: "Member number", kind: TEXT },
    { section: "Membership", label: "Organisation", kind: TEXT },
    { section: "Membership", label: "Tier", kind: TEXT },
    { section: "Membership", label: "Member since", kind: DATE },
    { section: "Membership", label: "Expires", kind: DATE },
    { section: "Access", label: "PIN", kind: SEALED },
    { section: "Access", label: "Website", kind: URL },
  ],
  document: [
    { section: "Document", label: "Reference", kind: TEXT },
    { section: "Document", label: "Issued by", kind: TEXT },
    { section: "Document", label: "Issued", kind: DATE },
    { section: "Document", label: "Expires", kind: DATE },
  ],
};

export function templateFor(type: string): readonly LockerTemplateField[] {
  return LOCKER_TYPE_TEMPLATES[type] ?? [];
}
