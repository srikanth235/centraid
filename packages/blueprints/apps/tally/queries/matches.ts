/**
 * CROSS-SOURCE MATCH PROPOSALS (#996, ruling R20(c), OQ-12).
 *
 * Two imports of the same real movement are two transactions until the owner
 * says otherwise. R20(c) deleted the inference that used to merge them — equal
 * reference strings across two sources, or two accounts sharing a display
 * label — and left the honest half unbuilt: a PROPOSAL the owner accepts or
 * rejects.
 *
 * This is that half's read. It proposes nothing on its own authority: a pair
 * is offered when the two rows are the same money on different accounts within
 * a few days of each other, and the owner's answer — either answer — is
 * written to `core_link` and takes the pair off this list for good. Nothing is
 * merged, nothing is hidden, and no row changes until an answer exists.
 *
 * NEVER AUTOMATIC is enforced by shape, not by comment: this handler writes
 * nothing at all. `accept-match` and `reject-match` are the only writers, and
 * both are owner actions.
 */

import { inList, readPages } from "../../_shared/paged-reads.ts";
import { deniedPayload } from "./dashboard.ts";

/** How far apart two postings of one movement may sit, in whole days. */
export const MATCH_WINDOW_DAYS = 4;

/** The most recent transactions a proposal is looked for among. */
export const MATCH_SCAN_ROWS = 500;

interface TxnRow {
  txn_id: string;
  account_id: string;
  posted_at: string;
  amount_minor: number;
  currency: string;
  direction: string;
  description: string | null;
}

interface AccountRow {
  account_id: string;
  name: string;
  external_ref: string | null;
}

interface DecisionRow {
  link_id: string;
  from_id: string;
  to_id: string;
}

export interface MatchProposal {
  left_txn_id: string;
  right_txn_id: string;
  amount_minor: number;
  currency: string;
  direction: string;
  left_posted_at: string;
  right_posted_at: string;
  left_account: string;
  right_account: string;
  left_description: string;
  right_description: string;
  /** Whole days between the two postings — the weakest part of the evidence. */
  days_apart: number;
}

const DAY_MS = 86_400_000;

function daysApart(left: string, right: string): number {
  const a = Date.parse(left);
  const b = Date.parse(right);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.POSITIVE_INFINITY;
  return Math.round(Math.abs(a - b) / DAY_MS);
}

/** An unordered pair, spelled one way so a decision matches either direction. */
function pairKey(left: string, right: string): string {
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

export default async function matchesHandler({ ctx }: HandlerArgs) {
  try {
    const transactions = await readPages<TxnRow>(ctx, {
      name: "tally.matches.transactions",
      select:
        "txn_id, account_id, posted_at, amount_minor, currency, direction, description",
      from: "core_transaction",
      where: "status <> ?",
      bind: ["void"],
      order: { sortColumn: "posted_at", pkColumn: "txn_id", descending: true },
    });
    // The scan window is stated where it is taken, and it is a WINDOW, not a
    // truncation: an older pair is not proposed because nobody is reconciling
    // last year's statement on this screen.
    const recent = transactions.slice(0, MATCH_SCAN_ROWS);
    if (recent.length === 0) return { proposals: [], accounts: {} };

    const decided = new Set<string>();
    const links = await readPages<DecisionRow>(ctx, {
      name: "tally.matches.decisions",
      select: "link_id, from_id, to_id",
      from: "core_link",
      where: "from_type = ? AND to_type = ? AND valid_to IS NULL",
      bind: ["core.transaction", "core.transaction"],
      order: { sortColumn: "link_id", pkColumn: "link_id", descending: false },
    });
    for (const link of links) decided.add(pairKey(link.from_id, link.to_id));

    // Same money, different account, near in time. The bucket is the exact
    // amount and currency — an amount that does not match is not this pair's
    // near miss, it is a different movement.
    const buckets = new Map<string, TxnRow[]>();
    for (const txn of recent) {
      const key = `${txn.currency}:${String(txn.amount_minor)}`;
      const held = buckets.get(key);
      if (held) held.push(txn);
      else buckets.set(key, [txn]);
    }

    const proposals: MatchProposal[] = [];
    for (const bucket of buckets.values()) {
      if (bucket.length < 2) continue;
      for (const [index, left] of bucket.entries()) {
        for (const right of bucket.slice(index + 1)) {
          if (left.account_id === right.account_id) continue;
          if (decided.has(pairKey(left.txn_id, right.txn_id))) continue;
          const apart = daysApart(left.posted_at, right.posted_at);
          if (apart > MATCH_WINDOW_DAYS) continue;
          proposals.push({
            left_txn_id: left.txn_id,
            right_txn_id: right.txn_id,
            amount_minor: left.amount_minor,
            currency: left.currency,
            direction: left.direction,
            left_posted_at: left.posted_at,
            right_posted_at: right.posted_at,
            left_account: left.account_id,
            right_account: right.account_id,
            left_description: left.description ?? "",
            right_description: right.description ?? "",
            days_apart: apart,
          });
        }
      }
    }
    // The nearest evidence first: a same-day pair is a stronger proposal than
    // one four days apart, and a member reviewing ten of these should meet the
    // easy answers first.
    proposals.sort(
      (a, b) =>
        a.days_apart - b.days_apart ||
        b.left_posted_at.localeCompare(a.left_posted_at)
    );

    const named = [
      ...new Set(
        proposals.flatMap((row) => [row.left_account, row.right_account])
      ),
    ];
    const accounts: Record<string, string> = {};
    if (named.length > 0) {
      const clause = inList("account_id", named);
      const rows = await readPages<AccountRow>(ctx, {
        name: "tally.matches.accounts",
        select: "account_id, name, external_ref",
        from: "core_account",
        where: clause.sql,
        bind: clause.bind,
        order: {
          sortColumn: "account_id",
          pkColumn: "account_id",
          descending: false,
        },
      });
      for (const row of rows) accounts[row.account_id] = row.name;
    }
    return { proposals, accounts };
  } catch (error) {
    return { proposals: [], accounts: {}, vaultDenied: deniedPayload(error) };
  }
}
