export type LockerItemType =
  | "login"
  | "card"
  | "note"
  | "identity"
  | "wifi"
  | "password"
  | "ssh_key"
  | "api_credential"
  | "passport"
  | "bank_account"
  | "driving_licence"
  | "software_licence"
  | "crypto_wallet"
  | "membership"
  | "document";

export interface LockerCustomField {
  field_id: string;
  section: string;
  label: string;
  kind: "text" | "sealed" | "url" | "date" | "otp";
  value: string | null;
  sealed?: boolean;
}

export interface LockerAddress {
  address_id: string;
  url: string;
  match_policy: UrlMatchPolicy;
}

export interface LockerPasskey {
  rp_id: string;
  user_handle?: string | null;
  display_name?: string | null;
  credential_id?: string | null;
  algorithm?: string | null;
  created_at?: string;
  has_private_key?: boolean;
}

export interface LockerRevision {
  revision_id: string;
  operation: string;
  changed?: Record<string, unknown>;
  recorded_at: string;
}

export interface LockerAccessEntry {
  receipt_id: string;
  kind: "auth" | "reveal" | "fill";
  action: string;
  decision: "allow" | "deny";
  item_id: string | null;
  occurred_at: string;
  origin?: string | null;
  columns?: string[];
  reason?: string;
}

export type UrlMatchPolicy = "registrable-domain" | "exact-host";

export type CheckKey =
  | "compromised"
  | "weak"
  | "reused"
  | "http"
  | "expiring"
  | "age";

export interface LockerRow {
  item_id: string;
  type: LockerItemType;
  title: string;
  subtitle?: string;
  favorite?: boolean;
  tags?: string[];
  weak?: boolean;
  reused?: boolean;
  compromised?: boolean;
  severity?: string;
  updated_at?: string;
  purge_at?: string | null;
  url?: string | null;
  expiry?: string | null;
  alias?: string | null;
  archived?: boolean;
  password_set_at?: string | null;
}

export interface LockerDetail {
  item_id: string;
  type: LockerItemType;
  degraded_from?: string | null;
  title: string;
  username?: string | null;
  password?: string | null;
  url?: string | null;
  url_match_policy?: UrlMatchPolicy | null;
  otp_seed?: string | null;
  notes?: string | null;
  cardholder?: string | null;
  card_number?: string | null;
  expiry?: string | null;
  cvv?: string | null;
  brand?: string | null;
  content?: string | null;
  fullname?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  network?: string | null;
  compromised?: boolean;
  favorite?: boolean;
  tags?: string[];
  trashed?: boolean;
  alias?: string | null;
  archived?: boolean;
  archived_at?: string | null;
  password_set_at?: string | null;
  fields?: LockerCustomField[];
  addresses?: LockerAddress[];
  passkey?: LockerPasskey | null;
  history?: LockerRevision[];
  attachments?: {
    attachment_id: string;
    content_id: string;
    role: string;
    title?: string | null;
    media_type?: string | null;
    byte_size?: number | null;
  }[];
  purge_at?: string | null;
  updated_at?: string;
}

export interface AuthPayload {
  ok?: boolean;
  configured?: boolean;
  authenticated?: boolean;
  sessionToken?: string;
  itemToken?: string;
  credentialId?: string;
  expiresAt?: string;
  retryAfterMs?: number;
  code?: string;
  message?: string;
}

export interface ItemsPayload {
  items?: LockerRow[];
  truncated?: boolean;
  window?: number;
  total?: number;
  byType?: { type: string; n: number }[];
  archivedCount?: number;
  trashedCount?: number;
  watchtower?: {
    compromised?: number;
    weak?: number;
    reused?: number;
    items?: LockerRow[];
  };
  authRequired?: boolean;
  configured?: boolean;
  vaultDenied?: { code?: string; message?: string } | null;
}

export interface WatchState {
  compromised: number;
  weak: number;
  reused: number;
  items: LockerRow[];
}

export type ItemFilter =
  | { kind: "all" }
  | { kind: "starred" }
  | { kind: "review" }
  | { kind: "verdict"; check: CheckKey }
  | { kind: "type"; type: LockerItemType }
  | { kind: "tag"; tag: string }
  | { kind: "archived" };

export interface ItemField {
  key: string;
  secretField?: string;
  value?: string | null;
  note?: string;
  numeric?: boolean;
}

export interface ItemDraftSeed {
  mode: "new" | "edit";
  itemId?: string;
  type: LockerItemType;
  title: string;
  tags: string;
  alias: string;
  urlMatchPolicy: UrlMatchPolicy;
  fields: Record<string, string>;
}

export interface Verdict {
  label: string;
  tone: "net" | "seam";
}
