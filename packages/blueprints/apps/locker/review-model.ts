// REVIEW, AS TWO REGISTERS (README-Locker §5, "Review"; GAPS §3.3 #6a–6e).
//
// A verdict list, NOT A SCORE. The first register is what this product can
// honestly check and what it found; the second is every check that could not
// run, each with the reason — listed rather than left out, because a review
// surface that silently omits what it cannot do is a review surface that
// overstates itself.
//
// AND A THIRD FACT THIS FILE MAKES STRUCTURAL: a check whose PRODUCER exists
// but whose data does not reach this screen is neither of those things. The
// items read folds the vault's watchtower aggregate in (weak, reused,
// compromised), but it decorates no address and no expiry — so *Unsecured
// address* and *Expiring* have a producer, a source, and nothing to read.
// `servedFields` names that as its own state instead of reporting a zero:
// "checked, and found none" and "not asked" are different sentences, and only
// one of them is true here today. The day the items query decorates those two
// fields, the same code moves both checks into the first register with no
// edit — which is what makes this a state rather than a hard-coded apology.
//
// Pure: no JSX, no IO, and no clock but the one passed in.

import { matchesCheck } from "./format.ts";
import {
  CHECK_LABEL,
  CHECK_WHY,
  UNRUNNABLE_CHECKS,
  UNSERVED_WHY,
} from "./route-copy.ts";
import type { CheckKey, LockerRow } from "./types.ts";

/** One row of the *Needs attention* register. */
export interface VerdictRow {
  key: CheckKey;
  label: string;
  /** Why this check says what it says — including its gap tag, where it has
   *  one, because the tag belongs on the surface (GAPS.md's own rule). */
  why: string;
  count: number;
  /** `--net` for compromised, the seam for the rest: compromised is the one
   *  verdict with a consequence outside this device. */
  tone: "net" | "seam";
  items: LockerRow[];
}

/** One row of *Checked, and cannot be checked* — a check with no honest
 *  answer, and the reason it has none. */
export interface UnrunnableRow {
  key: string;
  label: string;
  why: string;
}

/** Which facts the items payload actually carries. Derived from the ROWS, so
 *  a backend that starts decorating the field flips the register with no
 *  change here: `decorate()` sets a key on every row or on none. */
export interface ServedFields {
  address: boolean;
  expiry: boolean;
}

export function servedFields(rows: readonly LockerRow[]): ServedFields {
  return {
    address: rows.some((row) => "url" in row),
    expiry: rows.some((row) => "expiry" in row),
  };
}

/** Which of the five checks this payload can answer at all. */
function answerable(key: CheckKey, served: ServedFields): boolean {
  if (key === "http") return served.address;
  if (key === "expiring") return served.expiry;
  return true;
}

const CHECK_ORDER: readonly CheckKey[] = [
  "compromised",
  "weak",
  "reused",
  "http",
  "expiring",
];

/** The whole of Review, as one value. */
export interface ReviewRegister {
  /** The verdicts with something behind them, worst first. */
  attention: VerdictRow[];
  /** Every check that could not run, whatever the reason — an absent source
   *  and an unserved read read the same to a member: nothing was checked. */
  unrunnable: UnrunnableRow[];
  /** The rows behind the verdicts, deduplicated, in the register's order. */
  items: LockerRow[];
  /** How many verdicts across how many checks — the section's own meta. */
  verdicts: number;
  /** Every check that DID run, for the all-clear screen's account of itself. */
  ran: CheckKey[];
  allClear: boolean;
}

export function reviewRegister(
  rows: readonly LockerRow[],
  now: number = Date.now()
): ReviewRegister {
  const served = servedFields(rows);
  const attention: VerdictRow[] = [];
  const unrunnable: UnrunnableRow[] = [];
  const ran: CheckKey[] = [];
  for (const key of CHECK_ORDER) {
    if (!answerable(key, served)) {
      unrunnable.push({
        key,
        label: CHECK_LABEL[key] ?? key,
        why: UNSERVED_WHY[key] ?? CHECK_WHY[key] ?? "",
      });
      continue;
    }
    ran.push(key);
    const held = rows.filter((row) => matchesCheck(row, key, now));
    if (held.length === 0) continue;
    attention.push({
      key,
      label: CHECK_LABEL[key] ?? key,
      why: CHECK_WHY[key] ?? "",
      count: held.length,
      tone: key === "compromised" ? "net" : "seam",
      items: held,
    });
  }
  unrunnable.push(...UNRUNNABLE_CHECKS);
  const seen = new Set<string>();
  const items: LockerRow[] = [];
  for (const verdict of attention) {
    for (const row of verdict.items) {
      if (seen.has(row.item_id)) continue;
      seen.add(row.item_id);
      items.push(row);
    }
  }
  return {
    attention,
    unrunnable,
    items,
    verdicts: attention.reduce((total, row) => total + row.count, 0),
    ran,
    allClear: attention.length === 0,
  };
}
