// THE ROOM'S MUTABLE STATE, IN TWO HALVES.
//
// `SecretBag` (session.ts) is the half that holds, or is derived from, a
// secret: an enumerated list, wiped as a unit, never serialised and never
// logged. `ViewBag` is everything else — a filter, a route's scratch, a chip
// row's settings. They live in ONE object because there is one ref and one
// bump, and they are DECLARED apart because "what does a lock erase" has to
// stay a question with an enumerated answer.
//
// THE RULE FOR ANYTHING NEW: if a field could hold a secret, or is derived
// from one, it goes in `SecretBag` and joins `SECRET_BEARING_KEYS` — the wipe
// covers exactly that list and `session.test.ts` pins the two together. If it
// could not, it goes here. The add / edit form's typed values and the
// generator's output are already there (`editSeed`, `generated`); the chip
// rows that PRODUCED that output are here, because a length and two toggles
// reveal nothing about the string they made.
//
// This file is separate from the orchestrator so the route handlers
// (`route-acts.ts`) can be typed against the same bag without importing the
// component tree that owns it.

import type { SearchStatus } from "../_shared/search-scaffold.ts";
import { defaultGenOptions } from "./gen-model.ts";
import type { GenOptions } from "./gen-model.ts";
import type { StagedBatch } from "./import-model.ts";
import { emptySecretBag } from "./session.ts";
import type { SecretBag } from "./session.ts";
import type { ItemFilter, LockerRow } from "./types.ts";

/** The default window the items query takes, and the step Show more adds. */
export const WINDOW_STEP = 300;
/** The query's own ceiling (app.json → queries.items.limit.maximum). */
export const WINDOW_MAX = 2000;

/** What a confirm is standing open for. Two acts reach it, and they are not
 *  the same act: one is reversible and offers Undo, the other is not. */
export interface ConfirmState {
  kind: "trash" | "purge";
  itemId: string;
}

/** The non-secret half. Kept beside `SecretBag` rather than inside it. */
export interface ViewBag {
  filter: ItemFilter;
  items: LockerRow[];
  windowSize: number;
  truncated: boolean;
  openItemId: string | null;
  moreOpen: boolean;
  confirm: ConfirmState | null;
  narrow: boolean;
  /** A reveal ran out of permit with nothing left on screen. Stated, so a
   *  member who looks back at a concealed field knows WHY it concealed rather
   *  than wondering whether they imagined the value. */
  reauthExpired: boolean;
  /** When the items read last actually answered. The stale notice's own fact,
   *  and `null` until one has — a lag nobody measured is not a lag. */
  lastMatchedAt: string | null;
  /** The generator's three chip rows. Not secret: they describe the shape of
   *  a string, never the string. */
  genOptions: GenOptions;
  /** Which of the four search states the surface is in. The TERM and the
   *  RESULTS are in the secret bag; this is not one of them. */
  searchStatus: SearchStatus;
  /** Which search a late answer belongs to — an older reply never overwrites
   *  a newer term. */
  searchSeq: number;
  /** What the add / edit form refused, in its own words. */
  editError: string;
  /** How many live items EXIST, as the vault counted them — the other half of
   *  "300 of 312". `null` when the count could not be read, and the foot then
   *  says what it knows rather than inventing a denominator. */
  total: number | null;
  /** How many items are archived, for the rail's own row. */
  archivedCount: number;
  /** The draft batches the import plane is holding, and which of them is open
   *  for review. Metadata only — the ROWS live in the secret bag. */
  importBatches: StagedBatch[] | null;
  openBatchId: string | null;
  /** What the import surface itself refused or settled, in its own words. */
  importNote: string;
  /** The access history's own window, and whether it is narrowed to one item. */
  accessWindow: { window: number; truncated: boolean } | null;
  accessItemId: string | null;
  /** The export screen's two switches, and whether its confirm stands. */
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
