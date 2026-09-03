import type { SearchStatus } from "../_shared/search-scaffold.ts";
import { defaultGenOptions } from "./gen-model.ts";
import type { GenOptions } from "./gen-model.ts";
import type { StagedBatch } from "./import-model.ts";
import { emptySecretBag } from "./session.ts";
import type { SecretBag } from "./session.ts";
import type { ItemFilter, LockerRow } from "./types.ts";

export const WINDOW_STEP = 300;
export const WINDOW_MAX = 2000;

export interface ConfirmState {
  kind: "trash" | "purge";
  itemId: string;
}

export interface ViewBag {
  filter: ItemFilter;
  items: LockerRow[];
  windowSize: number;
  truncated: boolean;
  openItemId: string | null;
  moreOpen: boolean;
  confirm: ConfirmState | null;
  narrow: boolean;
  reauthExpired: boolean;
  lastMatchedAt: string | null;
  genOptions: GenOptions;
  searchStatus: SearchStatus;
  searchSeq: number;
  editError: string;
  total: number | null;
  archivedCount: number;
  importBatches: StagedBatch[] | null;
  openBatchId: string | null;
  importNote: string;
  accessWindow: { window: number; truncated: boolean } | null;
  accessItemId: string | null;
  exportTrashed: boolean;
  exportHistory: boolean;
  exportConfirm: boolean;
}

export type Bag = SecretBag & ViewBag;

export function makeBag(): Bag {
  return {
    ...emptySecretBag(),
    filter: { kind: "all" },
    items: [],
    windowSize: WINDOW_STEP,
    truncated: false,
    openItemId: null,
    moreOpen: false,
    confirm: null,
    narrow: false,
    reauthExpired: false,
    lastMatchedAt: null,
    genOptions: defaultGenOptions(),
    searchStatus: "resting",
    searchSeq: 0,
    editError: "",
    total: null,
    archivedCount: 0,
    importBatches: null,
    openBatchId: null,
    importNote: "",
    accessWindow: null,
    accessItemId: null,
    exportTrashed: false,
    exportHistory: false,
    exportConfirm: false,
  };
}
