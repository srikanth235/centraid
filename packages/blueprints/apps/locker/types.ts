// Type-only — value imports 404 at serve time; importers MUST `import type`.

/** Mirrors the `locker_item.type` CHECK constraint (#712 C4). */
export type LockerItemType =
  | "login"
  | "card"
  | "note"
  | "identity"
  | "wifi"
  | "password";

/** Secret-free decorated row (items/search/trash). */
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
}

/** Full, secret-bearing detail-pane item. */
export interface LockerDetail {
  item_id: string;
  type: LockerItemType;
  title: string;
  username?: string | null;
  password?: string | null;
  url?: string | null;
  url_match_policy?: "registrable-domain" | "exact-host" | null;
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
  /** Connector alias (#298). */
  alias?: string | null;
  purge_at?: string | null;
  updated_at?: string;
}

export type Nav =
  | { kind: "all" }
  | { kind: "fav" }
  | { kind: "watch" }
  | { kind: "trash" }
  | { kind: "cat"; type: string }
  | { kind: "tag"; tag: string };

/** Watchtower summary rows. */
export interface WatchState {
  compromised: number;
  weak: number;
  reused: number;
  items: LockerRow[];
}

/** Seed the edit modal opens from. */
export interface EditSeed {
  mode: "new" | "edit";
  id?: string;
  type: LockerItemType;
  title: string;
  fields: Record<string, string>;
  tags: string;
  alias: string;
  urlMatchPolicy: "registrable-domain" | "exact-host";
}

/** Payload the edit modal hands back to `saveItem`. */
export interface SavePayload {
  mode: "new" | "edit";
  id?: string;
  type: LockerItemType;
  title: string;
  tags: string;
  alias?: string;
  urlMatchPolicy: "registrable-domain" | "exact-host";
  fields: Record<string, string>;
  allowedKeys: string[];
}

/** Mutated in place, NEVER reassigned. */
export interface AppState {
  nav: Nav;
  selectedId: string | null;
  detail: LockerDetail | null;
  detailLoading: boolean;
  reveal: Record<string, boolean>;
  search: string;
  searchResults: LockerRow[] | null;
  narrow: boolean;
  sideOpen: boolean;
  showList: boolean;
  locked: boolean;
  authConfigured: boolean | null;
  authSession: string | null;
  authBusy: boolean;
  authError: string;
  revealItemId: string | null;
  reauthOpen: boolean;
  gen: boolean;
  genLen: number;
  genNum: boolean;
  genSym: boolean;
  genValue: string;
  genApply: ((password: string) => void) | null;
  edit: EditSeed | null;
  trashRows: LockerRow[];
  watch: WatchState;
  denied: boolean;
  readFailedShown: boolean;
}

export interface AppData {
  items: LockerRow[];
  truncated: boolean;
}
