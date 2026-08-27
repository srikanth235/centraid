// THE PHONE'S OWN TABLES — the derivations this seat needs that no other seat
// does, and nothing else.
//
// Everything a seat SHARES is imported: the row recipe is `format.ts`, the
// window's foot is `format.windowEndCopy`, the two registers of Review are
// `review-model.ts`, the field sets are `item-fields.ts`, every sentence is
// `view-copy.ts` / `route-copy.ts`. What is genuinely this seat's own is here:
//
//   1. WHICH DESIGNED STATE A SCREEN IS IN. Seven states plus Locker's own,
//      resolved once so nine surfaces cannot each decide differently which
//      notice they are showing (STATES.md's matrix).
//   2. WHAT A SURFACE THIS SEAT CANNOT PERFORM SAYS. Import and Export are
//      custodian surfaces and Companion is the extension's; the phone draws
//      each as facts and the sentence that says where the act happens, which
//      is a DIFFERENT fact from the one the desktop states and therefore
//      different words (docs/blueprint-seats.md, "search is not one
//      behaviour").
//
// Pure: no `react-native` import, so `locker-view-model.test.ts` asserts it
// directly.

import { windowEndCopy } from "@centraid/blueprints/apps/locker/format";
import {
  EXPORT_FORMAT_NOTE,
  EXPORT_FORMAT_VALUE,
  EXPORT_FORMAT_ROW,
  EXPORT_HEAD,
  EXPORT_LEDE_TAIL,
  EXPORT_WHAT_ROW,
  EXPORT_WHERE_NOTE,
  EXPORT_WHERE_ROW,
  EXPORT_WHERE_VALUE,
  FILL_GET,
  FILL_GET_ROW,
  FILL_HEAD,
  FILL_LEDE,
  FILL_OFFERS,
  FILL_OFFERS_ROW,
  FILL_WHERE,
  IMPORT_HEAD,
  IMPORT_LEDE,
  IMPORT_PUBLISH_NOTE,
  IMPORT_PUBLISH_ROW,
  IMPORT_VERDICTS_ROW,
  exportWhat,
} from "@centraid/blueprints/apps/locker/route-copy";
import {
  EXPORT_LEDE,
  IMPORT_VERDICT,
} from "@centraid/blueprints/apps/locker/view-copy";

// ─── 1 · Which state a screen is in ─────────────────────────────────────────

/**
 * The seven designed states plus the two of Locker's own that a LIST-bearing
 * surface can be in. `ready` is the eighth answer and the commonest: there is
 * nothing to say, so nothing is said.
 *
 * `denied`, `refused` and `dayone` are deliberately three values and not one
 * emptiness: denied is a revoked grant with a receipt behind it, day one is an
 * invitation, and the two look nothing alike (STATES.md, rule 1).
 */
export type LockerScreenState =
  | "loading"
  | "denied"
  | "offline"
  | "stale"
  | "pending"
  | "conflict"
  | "parked"
  | "dayone"
  | "reauth"
  | "ready";

export interface LockerStateInput {
  /** The read has not landed yet. Nothing is empty until a read has landed. */
  loaded: boolean;
  denied: boolean;
  online: boolean;
  /** Metadata writes still on this device — never a secret (writes.ts). */
  pending: number;
  /** A row carrying an unresolved edit from two devices. */
  conflicted: boolean;
  /** A purge asked for on a device that is not the owner's. */
  parked: boolean;
  /** A permit ran out with nothing revealed. */
  reauth: boolean;
  /** Rows in the window a landed read returned. */
  rows: number;
  /** The replica is behind the vault. */
  stale: boolean;
}

/**
 * ONE resolution, in precedence order, and the order is the argument:
 * a refusal outranks a delay, a delay outranks an emptiness, and an emptiness
 * outranks silence. A screen that showed "nothing is kept here yet" over a
 * denied read would be describing a vault it never got to look at.
 */
export function lockerScreenState(input: LockerStateInput): LockerScreenState {
  if (input.denied) return "denied";
  if (!input.loaded) return "loading";
  if (input.reauth) return "reauth";
  if (input.conflicted) return "conflict";
  if (input.parked) return "parked";
  if (!input.online) return "offline";
  if (input.pending > 0) return "pending";
  if (input.stale) return "stale";
  if (input.rows === 0) return "dayone";
  return "ready";
}

/**
 * The window's foot, or nothing.
 *
 * `windowEndCopy` is the shared derivation and it already carries the honest
 * variant: the items payload returns `truncated` and `window` and NO total, so
 * the sentence says what it is showing and that older items exist beyond it
 * rather than inventing README-Locker §6's denominator. The exact "300 of 312"
 * wording comes back the day the query serves a total, with no edit here.
 */
export function lockerWindowFoot(
  loaded: boolean,
  shown: number,
  truncated: boolean
): string | null {
  if (!loaded || shown === 0) return null;
  return windowEndCopy(shown, truncated);
}

/**
 * How many of the device's pending writes are Locker's.
 *
 * The multi-vault session's pending row carries its app in the LABEL
 * (`multi-vault-session.ts`: `${appId}: ${action}`) and nowhere else, so the
 * prefix is the only handle this seat has. Widening that row to carry `appId`
 * is a frame change and is not this app's to make; the parse is stated here,
 * once, rather than in each screen that wants the count.
 */
export function lockerPendingCount(
  pending: readonly { label: string }[]
): number {
  return pending.filter((change) => change.label.startsWith("locker:")).length;
}

// ─── 2 · The surfaces whose door is on another seat ──────────────────────────

export interface LockerSurfaceFact {
  key: string;
  value?: string;
  note?: string;
}

export interface LockerSurfaceCopy {
  title: string;
  lede: string;
  /** `--net` lede — the export warning is the one paragraph that earns it. */
  net?: boolean;
  facts: readonly LockerSurfaceFact[];
  /** Where the act actually happens, from this seat. */
  where: string;
}

/**
 * The custodian sentence. Import and Export are `custodian` in SURFACES.md's
 * seat column: their doors are beside the gateway, and this phone has none.
 * A greyed control would teach that the act is broken; this says where it is.
 */
export const CUSTODIAN_SEAT_NOTE =
  "This act belongs to the desktop, beside the gateway · this phone has no door to it.";

const IMPORT_SURFACE: LockerSurfaceCopy = {
  title: IMPORT_HEAD,
  lede: IMPORT_LEDE,
  facts: [
    {
      key: IMPORT_VERDICTS_ROW,
      value: [
        IMPORT_VERDICT.new,
        IMPORT_VERDICT.gapfill,
        IMPORT_VERDICT.held,
      ].join(" · "),
    },
    { key: IMPORT_PUBLISH_ROW, note: IMPORT_PUBLISH_NOTE },
  ],
  where: CUSTODIAN_SEAT_NOTE,
};

function exportSurface(items: number): LockerSurfaceCopy {
  return {
    title: EXPORT_HEAD,
    lede: `${EXPORT_LEDE} ${EXPORT_LEDE_TAIL}`,
    net: true,
    facts: [
      { key: EXPORT_WHAT_ROW, value: exportWhat(items) },
      {
        key: EXPORT_FORMAT_ROW,
        value: EXPORT_FORMAT_VALUE,
        note: EXPORT_FORMAT_NOTE,
      },
      {
        key: EXPORT_WHERE_ROW,
        value: EXPORT_WHERE_VALUE,
        note: EXPORT_WHERE_NOTE,
      },
    ],
    where: CUSTODIAN_SEAT_NOTE,
  };
}

const FILL_SURFACE: LockerSurfaceCopy = {
  title: FILL_HEAD,
  lede: FILL_LEDE,
  facts: [
    { key: FILL_OFFERS_ROW, note: FILL_OFFERS },
    { key: FILL_GET_ROW, note: FILL_GET },
  ],
  where: FILL_WHERE,
};

export type LockerSurfaceKey = "import" | "export" | "fill";

/** `items` is read only by Export, whose first fact is how much would leave. */
export function lockerSurfaceCopy(
  key: LockerSurfaceKey,
  items = 0
): LockerSurfaceCopy {
  if (key === "export") return exportSurface(items);
  return key === "import" ? IMPORT_SURFACE : FILL_SURFACE;
}
