// Shared page-side shapes for the locker app (TS conversion). Type-only — no
// runtime members — so every importer uses `import type`, which esbuild strips
// at serve time (a value import of this module would 404). Grounded in the
// query payloads: `LockerRow` is the secret-free decorated row the `items`/
// `search`/`trash` queries return; `LockerDetail` is the full, secret-bearing
// shape the single-item `item` query returns (the ONLY payload with secrets).

/** Secret-free decorated list row (items/search/trash queries). */
export interface LockerRow {
  item_id: string;
  type: string;
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

/** Full, secret-bearing item for the detail pane (single-item `item` query). */
export interface LockerDetail {
  item_id: string;
  type: string;
  title: string;
  username?: string | null;
  password?: string | null;
  url?: string | null;
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
  /** Connector alias (issue #298 item 4); not returned by the read today. */
  alias?: string | null;
  purge_at?: string | null;
  updated_at?: string;
}

/** The current sidebar navigation selection. */
export type Nav =
  | { kind: 'all' }
  | { kind: 'fav' }
  | { kind: 'watch' }
  | { kind: 'trash' }
  | { kind: 'cat'; type: string }
  | { kind: 'tag'; tag: string };

/** Watchtower summary + needs-attention rows (from the `items` query). */
export interface WatchState {
  compromised: number;
  weak: number;
  reused: number;
  items: LockerRow[];
}

/** The seed the edit modal opens from (built by openNew/openEdit). */
export interface EditSeed {
  mode: 'new' | 'edit';
  id?: string;
  type: string;
  title: string;
  fields: Record<string, string>;
  tags: string;
  alias: string;
}

/** The payload the edit modal hands back to `saveItem`. */
export interface SavePayload {
  mode: 'new' | 'edit';
  id?: string;
  type: string;
  title: string;
  tags: string;
  alias?: string;
  fields: Record<string, string>;
  allowedKeys: string[];
}

/**
 * The module-level `state` bag app.tsx mutates in place (never reassigned) and
 * logic.ts closes over. `data` is the separate secret-free row store.
 */
export interface AppState {
  nav: Nav;
  selectedId: string | null;
  detail: LockerDetail | null;
  detailLoading: boolean;
  reveal: Record<string, boolean>;
  search: string;
  searchResults: LockerRow[] | null;
  dark: boolean;
  narrow: boolean;
  sideOpen: boolean;
  showList: boolean;
  locked: boolean;
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
