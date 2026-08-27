// HOW AN EXPENSE DIVIDES — the six methods, the allocation, and the reconcile
// line that changes WITH the method (Tally spec §3).
//
// THIS IS ARITHMETIC ON A FORM, NOT A BALANCE. Every figure Tally *reads*
// arrives folded by `queries/dashboard.ts`'s one engine, and the interface
// never recomputes one. What happens here is the opposite direction: a member
// is COMPOSING a write, and the shares they are about to send have to be
// resolved before the vault can re-validate them. `app.json`'s `add-expense`
// says so outright — "the split method is resolved to a splits map
// client-side; the command re-validates it sums to the amount". So this module
// validates an INPUT; it derives no stored figure, and it is pure and tested
// precisely so the one place that does this is inspectable.
//
// THE ODD PENNY GOES TO THE PAYER, ALWAYS. `packages/client/src/receipt-capture.ts`
// spreads its remainder over the earlier parties, which is right for a receipt
// line where nobody fronted anything; an expense has a payer, and the person
// who is already out of pocket carries the rounding. The semantics are mirrored
// rather than imported: blueprint apps do not reach into the client package.
//
// ALL SIX COMMIT. `tally.add_expense` takes the resolved shares plus the
// METHOD that produced them (`split_method`) and the numbers the member typed
// (`split_params`), so re-opening an expense re-opens the way it was entered
// rather than collapsing to exact amounts. The arithmetic stays here, on the
// client, because it is an INPUT being resolved before it is sent — the vault
// re-validates that it sums (GAPS.md Tally §1, §2).
import { money } from "./format.ts";

export type Division =
  | "equal"
  | "exact"
  | "percent"
  | "shares"
  | "adjust"
  | "lines";

/** What the number typed beside a person MEANS under this division. `derived`
 *  is the one the member does not type: equal shares are computed. `lines` is
 *  the one that is not per-person at all — the member types LINES, and who was
 *  on each of them decides the shares. */
export type DivisionUnit = "derived" | "money" | "percent" | "shares" | "lines";

/** The word `tally.add_expense` records the method under, so an edit re-opens
 *  the way the expense was entered. */
export type SplitMethod =
  | "equally"
  | "exact"
  | "percentages"
  | "shares"
  | "adjusted"
  | "by_line";

export interface DivisionSpec {
  id: Division;
  label: string;
  /** The stored `split_method` this division resolves to. */
  method: SplitMethod;
  unit: DivisionUnit;
}

/** The six, in the spec's own order. */
export const DIVISIONS: readonly DivisionSpec[] = [
  { id: "equal", label: "Equally", method: "equally", unit: "derived" },
  { id: "exact", label: "Exact amounts", method: "exact", unit: "money" },
  {
    id: "percent",
    label: "Percentages",
    method: "percentages",
    unit: "percent",
  },
  { id: "shares", label: "Shares", method: "shares", unit: "shares" },
  {
    id: "adjust",
    label: "Equally, adjusted",
    method: "adjusted",
    unit: "money",
  },
  { id: "lines", label: "By line", method: "by_line", unit: "lines" },
];

/** The division a stored `split_method` re-opens as. An unknown word — a
 *  method a later vault learned and this build has not — re-opens as exact
 *  amounts, which is what is actually known: the stored numbers, editable. */
export function divisionOfMethod(method: string | undefined): Division {
  return (
    DIVISIONS.find((spec) => spec.method === method)?.id ??
    ("exact" as Division)
  );
}

const BY_ID = new Map(DIVISIONS.map((spec) => [spec.id, spec]));

export function divisionSpec(id: Division): DivisionSpec {
  return BY_ID.get(id) ?? DIVISIONS[0]!;
}

/** One resolved share, in the shape `add-expense` requires. */
export interface Share {
  party_id: string;
  share_minor: number;
}

/** One typed value beside a person, in the division's own unit. */
export interface Entry {
  party_id: string;
  value: number;
}

/**
 * Split an amount across weights in MINOR UNITS, exactly.
 *
 * Every share is floored, and the pennies left over are handed out one at a
 * time — the payer first, then the rest in table order. With `n` participants
 * the remainder is always under `n`, so "the odd penny goes to the payer" is
 * the whole of the rule in the ordinary case, and the spill order keeps it
 * total when three ways leave two pennies.
 */
export function allocateWeighted(
  amountMinor: number,
  entries: readonly Entry[],
  payerId: string
): Share[] {
  if (entries.length === 0) return [];
  const weights = entries.map((entry) => Math.max(0, entry.value));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0)
    return entries.map((entry) => ({
      party_id: entry.party_id,
      share_minor: 0,
    }));
  const shares = entries.map((entry, index) => ({
    party_id: entry.party_id,
    share_minor: Math.floor((amountMinor * weights[index]!) / total),
  }));
  let remainder =
    amountMinor - shares.reduce((sum, share) => sum + share.share_minor, 0);
  const payerIndex = entries.findIndex((entry) => entry.party_id === payerId);
  const order = [
    ...(payerIndex >= 0 ? [payerIndex] : []),
    ...entries.map((_, index) => index).filter((index) => index !== payerIndex),
  ];
  for (const index of order) {
    if (remainder <= 0) break;
    shares[index]!.share_minor += 1;
    remainder -= 1;
  }
  return shares;
}

/** Equal shares, with the odd penny on the payer. */
export function allocateEqually(
  amountMinor: number,
  partyIds: readonly string[],
  payerId: string
): Share[] {
  return allocateWeighted(
    amountMinor,
    partyIds.map((party_id) => ({ party_id, value: 1 })),
    payerId
  );
}

export interface AllocationInput {
  division: Division;
  /** The expense, in the currency the group settles in. */
  amountMinor: number;
  /** Who it divides between, in the order the table draws them. */
  participants: readonly string[];
  payerId: string;
  /** What the member typed beside each person, in the division's own unit. */
  entries: Readonly<Record<string, number>>;
  currency: string;
}

export interface Allocation {
  shares: Share[];
  /** Does this allocation commit? Every method is backed now, so this is the
   *  arithmetic's own verdict: percentages at 99 do not commit, exact amounts
   *  a pound out do not, and weights always do. */
  ok: boolean;
  /** Is the ARITHMETIC sound, independently of whether the vault backs the
   *  method? The reconcile line reads true or false off this. */
  balanced: boolean;
  /** The sentence under the allocation table. */
  line: string;
}

function valueOf(input: AllocationInput, partyId: string): number {
  const raw = input.entries[partyId];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

/** The typed amounts, as shares, with no re-allocation: exact, adjusted and
 *  by-line all mean "this is the number, and it either sums or it does not". */
function typedShares(input: AllocationInput): Share[] {
  return input.participants.map((party_id) => ({
    party_id,
    share_minor: Math.round(valueOf(input, party_id)),
  }));
}

function sumOf(shares: readonly Share[]): number {
  return shares.reduce((sum, share) => sum + share.share_minor, 0);
}

/** One penny of tolerance, the spec's own words, and not a hair more. */
const TOLERANCE_MINOR = 1;

function equalLine(input: AllocationInput): string {
  return `${money(input.amountMinor, input.currency)} divided ${input.participants.length} ways · the odd penny goes to the payer, always`;
}

function exactLine(input: AllocationInput, sum: number): string {
  if (Math.abs(sum - input.amountMinor) <= TOLERANCE_MINOR)
    return `The ${input.participants.length} amounts sum to ${money(input.amountMinor, input.currency)} · a penny of tolerance either way`;
  return `${money(sum, input.currency)} of ${money(input.amountMinor, input.currency)} · a penny of tolerance either way, and this is more`;
}

function percentLine(input: AllocationInput, total: number): string {
  const parts = input.participants.map((party_id) =>
    String(valueOf(input, party_id))
  );
  return `${parts.join(" + ")} = ${total} · it will not commit at 99`;
}

function sharesLine(input: AllocationInput, total: number): string {
  const parts = input.participants.map((party_id) =>
    String(valueOf(input, party_id))
  );
  if (total <= 0)
    return `${parts.join(" : ")} · weights, and nothing weighs anything yet`;
  return `${parts.join(" : ")} · weights, the way a recurring template already splits`;
}

function adjustLine(input: AllocationInput, sum: number): string {
  const base = money(
    Math.floor(input.amountMinor / Math.max(1, input.participants.length)),
    input.currency
  );
  if (sum === input.amountMinor)
    return `${base} each, then the adjustments · they come back to ${money(input.amountMinor, input.currency)}`;
  return `${base} each, then the adjustments · they come to ${money(sum, input.currency)} against ${money(input.amountMinor, input.currency)}`;
}

/**
 * The allocation table's rows and the sentence under them, for one division.
 *
 * Every branch returns SHARES and its own reconcile line, because the table is
 * the review surface: a member has to be able to read what the write would
 * carry before they send it. "By line" is NOT here — its table is typed lines
 * rather than a cell per person, so it lives in `line-model.ts` and returns
 * this same `Allocation`.
 */
export function allocate(input: AllocationInput): Allocation {
  if (input.division === "equal") {
    const shares = allocateEqually(
      input.amountMinor,
      input.participants,
      input.payerId
    );
    return { shares, ok: true, balanced: true, line: equalLine(input) };
  }
  if (input.division === "percent") {
    const total = input.participants.reduce(
      (sum, party_id) => sum + valueOf(input, party_id),
      0
    );
    const balanced = total === 100;
    const shares = allocateWeighted(
      input.amountMinor,
      input.participants.map((party_id) => ({
        party_id,
        value: valueOf(input, party_id),
      })),
      input.payerId
    );
    return { shares, ok: balanced, balanced, line: percentLine(input, total) };
  }
  if (input.division === "shares") {
    // WEIGHTS ALWAYS RESOLVE, so the only way this fails to commit is nobody
    // weighing anything: a table of zeroes would write an expense divided
    // between nobody.
    const total = input.participants.reduce(
      (sum, party_id) => sum + Math.max(0, valueOf(input, party_id)),
      0
    );
    const shares = allocateWeighted(
      input.amountMinor,
      input.participants.map((party_id) => ({
        party_id,
        value: valueOf(input, party_id),
      })),
      input.payerId
    );
    return {
      shares,
      ok: total > 0,
      balanced: total > 0,
      line: sharesLine(input, total),
    };
  }
  if (input.division === "adjust") {
    // An EQUAL BASE, then a per-person adjustment. The base carries the odd
    // penny exactly as "Equally" does, so the two agree when every adjustment
    // is zero — which is the whole claim the reconcile line makes.
    const base = allocateEqually(
      input.amountMinor,
      input.participants,
      input.payerId
    );
    const shares = base.map((share) => ({
      party_id: share.party_id,
      share_minor:
        share.share_minor + Math.round(valueOf(input, share.party_id)),
    }));
    const sum = sumOf(shares);
    const balanced = sum === input.amountMinor;
    return { shares, ok: balanced, balanced, line: adjustLine(input, sum) };
  }
  const shares = typedShares(input);
  const sum = sumOf(shares);
  const balanced = Math.abs(sum - input.amountMinor) <= TOLERANCE_MINOR;
  return { shares, ok: balanced, balanced, line: exactLine(input, sum) };
}

/** The equal shares a table pre-fills its typed cells from, so a member who
 *  switches to exact amounts starts from something that already sums. */
export function prefill(
  division: Division,
  amountMinor: number,
  participants: readonly string[],
  payerId: string
): Record<string, number> {
  const unit = divisionSpec(division).unit;
  const out: Record<string, number> = {};
  // BY LINE HAS NO PER-PERSON CELL. Its table is typed lines, so there is
  // nothing beside a person to pre-fill and an empty map is the truth.
  if (unit === "lines") return out;
  if (unit === "shares") {
    for (const party_id of participants) out[party_id] = 1;
    return out;
  }
  if (unit === "percent") {
    const each = Math.floor(100 / Math.max(1, participants.length));
    for (const party_id of participants) out[party_id] = each;
    const first = participants[0];
    if (first !== undefined)
      out[first] = 100 - each * (participants.length - 1);
    return out;
  }
  if (division === "adjust") {
    for (const party_id of participants) out[party_id] = 0;
    return out;
  }
  for (const share of allocateEqually(amountMinor, participants, payerId))
    out[share.party_id] = share.share_minor;
  return out;
}
