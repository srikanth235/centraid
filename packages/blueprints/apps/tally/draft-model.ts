// WHAT A MEMBER IS COMPOSING, before any of it is a write.
//
// A draft is a VALUE — typed text, chosen chips — and this module turns one
// into either the exact input a manifest action requires or a refusal that
// names what is missing. Both halves are pure, so the rules a commit stands on
// are readable and testable without a renderer, and a field the vault would
// reject cannot be assembled inside a render.
//
// THE REFUSALS ARE ORDERED, and the order is the reading order of the form: a
// member is told about the field they have not filled yet, not about the one
// three sections below it.
//
// NINE CATEGORIES, CLOSED. The enum below is `tally.add_expense`'s own
// `CATEGORY_ENUM`, restated here because the interface must not offer a tenth
// — the ruling is that nine suffice, they exist to make Spending legible, and
// a second level is a taxonomy to maintain forever (GAPS.md Tally §11).
import { allocate, divisionSpec, prefill } from "./split-model.ts";
import type { Allocation, Division, Share } from "./split-model.ts";

export const CATEGORIES: readonly (readonly [string, string])[] = [
  ["food", "Food"],
  ["groceries", "Groceries"],
  ["rent", "Rent"],
  ["utilities", "Utilities"],
  ["transport", "Transport"],
  ["fun", "Fun"],
  ["travel", "Travel"],
  ["shopping", "Shopping"],
  ["general", "General"],
];

/** The fixed-point scale every rate this app supplies is expressed at. Six
 *  places is the vault's own maximum-useful precision for a rate a member read
 *  off a receipt, and the schema caps it at twelve. */
export const RATE_SCALE = 6;

/** `No group` is not a group id — it is the ABSENCE of one, and the write door
 *  refuses it. Held as its own value so the chip can be drawn honestly. */
export const NO_GROUP = null;

export interface ExpenseDraft {
  /** Present when this draft is an edit of an expense that already exists. */
  expenseId?: string;
  description: string;
  /** Typed, in whatever currency the member chose. */
  amount: string;
  payerId: string;
  groupId: string | null;
  category: string;
  /** The day it was spent, as a day key. */
  spentOn: string;
  /** Was it entered in something other than what the group settles in? */
  foreign: boolean;
  /** The currency it was entered in, when foreign. */
  currency: string;
  /** Typed: how many of the entered currency one settlement unit buys. */
  rate: string;
  rateSource: string;
  rateDate: string;
  division: Division;
  /** What was typed beside each person, AS TYPED — text, not a number, because
   *  a half-typed "1." is a legitimate state of an input and rounding it to a
   *  number on every keystroke would fight the member's hands. */
  entries: Record<string, string>;
}

export interface SettleDraft {
  fromId: string;
  toId: string;
  amount: string;
  groupId: string | null;
  paidOn: string;
}

/** Minor units from typed text, or `null` when it is not a number at all. A
 *  blank field is `null` rather than zero: nobody typed a zero. */
export function parseMoney(text: string): number | null {
  const trimmed = text.trim().replaceAll(",", "");
  if (trimmed === "") return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

/** A supplied rate, as the fixed point the vault stores. */
export function parseRate(
  text: string
): { rate_scaled: number; rate_scale: number } | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) return null;
  const scaled = Math.round(value * 10 ** RATE_SCALE);
  return scaled < 1 ? null : { rate_scaled: scaled, rate_scale: RATE_SCALE };
}

/**
 * What the expense comes to in the currency the group settles in.
 *
 * The typed amount is the one the member read off the bill; the settlement
 * figure is derived from the rate THEY supplied, with its source and date.
 * Nothing looks a rate up — there is no rate provider in the path of entering
 * an expense, and the vault works with none.
 */
export function settlementMinor(draft: ExpenseDraft): number | null {
  const original = parseMoney(draft.amount);
  if (original === null) return null;
  if (!draft.foreign) return original;
  const rate = parseRate(draft.rate);
  if (rate === null) return null;
  return Math.round((original * 10 ** rate.rate_scale) / rate.rate_scaled);
}

/**
 * The typed cells, as the numbers the allocation works in.
 *
 * The UNIT is the division's: money in minor units for exact amounts, an
 * adjustment and a typed line; a bare number for percentages and shares. One
 * function, so a percentage can never be read as pence on one screen and as a
 * percentage on the next.
 */
export function entryValues(
  division: Division,
  entries: Readonly<Record<string, string>>
): Record<string, number> {
  const unit = divisionSpec(division).unit;
  const out: Record<string, number> = {};
  for (const [partyId, text] of Object.entries(entries)) {
    if (unit === "money" || division === "adjust") {
      const trimmed = text.trim();
      const negative = trimmed.startsWith("-");
      const minor = parseMoney(negative ? trimmed.slice(1) : trimmed);
      out[partyId] = minor === null ? 0 : negative ? -minor : minor;
      continue;
    }
    const value = Number(text.trim());
    out[partyId] = Number.isFinite(value) ? value : 0;
  }
  return out;
}

/** The typed cells a table starts from, as text a member can edit. */
export function prefillEntries(
  division: Division,
  amountMinor: number,
  participants: readonly string[],
  payerId: string
): Record<string, string> {
  const unit = divisionSpec(division).unit;
  const numbers = prefill(division, amountMinor, participants, payerId);
  const out: Record<string, string> = {};
  for (const [partyId, value] of Object.entries(numbers))
    out[partyId] =
      unit === "money" || division === "adjust"
        ? (value / 100).toFixed(2)
        : String(value);
  return out;
}

export interface DraftVerdict {
  ok: boolean;
  /** Why it cannot commit, in the member's words. Absent when it can. */
  refusal?: string;
  /** The allocation, where there is enough of a draft to have one. */
  allocation?: Allocation;
  /** The resolved shares the write would carry. */
  splits: Share[];
  /** The expense in settlement minor units, where it can be worked out. */
  amountMinor: number | null;
}

export const REFUSALS = {
  description: "A description · it is what the expense will be called",
  amount: "An amount above zero",
  group: "An expense needs a group · the vault requires one",
  payer: "Who paid it",
  participants: "Someone to divide it between",
  rate: "The rate you read off the bill, as a number",
  currency: "A three-letter code for the currency it was entered in",
  unbacked: "This division is an engineering ask · three of the six commit",
  parties: "A settlement runs between two different people",
  same: "From and To are the same person",
} as const;

/**
 * Can this expense be written, and with what?
 *
 * `participants` is who the allocation table is drawing, in its order — the
 * group's members, so the vault's own "every participant is a member" check
 * cannot fail on something the interface offered.
 */
export function expenseVerdict(
  draft: ExpenseDraft,
  participants: readonly string[],
  currency: string
): DraftVerdict {
  const amountMinor = settlementMinor(draft);
  // THE TABLE APPEARS AS SOON AS THERE IS SOMEBODY TO DIVIDE BETWEEN, before
  // an amount is typed: who it splits between is a decision a member makes
  // first, and a table that materialised only after the amount would make the
  // division feel like an afterthought. An untyped amount divides as nothing,
  // and the reconcile line says so.
  const allocation =
    participants.length === 0
      ? undefined
      : allocate({
          division: draft.division,
          amountMinor: amountMinor ?? 0,
          participants,
          payerId: draft.payerId,
          entries: entryValues(draft.division, draft.entries),
          currency,
        });
  const splits = allocation?.shares ?? [];
  const refuse = (refusal: string): DraftVerdict => ({
    ok: false,
    refusal,
    ...(allocation ? { allocation } : {}),
    splits,
    amountMinor,
  });
  if (draft.description.trim() === "") return refuse(REFUSALS.description);
  if (parseMoney(draft.amount) === null || parseMoney(draft.amount) === 0)
    return refuse(REFUSALS.amount);
  if (draft.foreign && !/^[A-Za-z]{3}$/u.test(draft.currency.trim()))
    return refuse(REFUSALS.currency);
  if (draft.foreign && parseRate(draft.rate) === null)
    return refuse(REFUSALS.rate);
  if (draft.groupId === NO_GROUP) return refuse(REFUSALS.group);
  if (draft.payerId === "") return refuse(REFUSALS.payer);
  if (participants.length === 0) return refuse(REFUSALS.participants);
  if (!divisionSpec(draft.division).backed) return refuse(REFUSALS.unbacked);
  if (!allocation || !allocation.ok) return refuse(allocation?.line ?? "");
  return { ok: true, allocation, splits, amountMinor };
}

/** The currency provenance an expense carries, or nothing at all when it was
 *  entered in the currency the group already settles in. */
function provenance(
  draft: ExpenseDraft,
  settlementCurrency: string
): Record<string, unknown> {
  const original = parseMoney(draft.amount);
  if (!draft.foreign || original === null) return {};
  const rate = parseRate(draft.rate);
  if (rate === null) return {};
  return {
    original_amount_minor: original,
    original_currency: draft.currency.trim().toUpperCase(),
    settlement_currency: settlementCurrency.toUpperCase(),
    ...rate,
    ...(draft.rateSource.trim() === ""
      ? {}
      : { rate_source: draft.rateSource.trim() }),
    ...(draft.rateDate.trim() === "" ? {} : { rate_date: draft.rateDate }),
  };
}

/** Exactly what `add-expense` declares, and nothing else. */
export function addExpenseInput(
  draft: ExpenseDraft,
  verdict: DraftVerdict,
  settlementCurrency: string
): Record<string, unknown> {
  return {
    group_id: String(draft.groupId),
    description: draft.description.trim(),
    amount_minor: Number(verdict.amountMinor),
    paid_by: draft.payerId,
    category: draft.category,
    splits: verdict.splits,
    ...(draft.spentOn === "" ? {} : { spent_on: draft.spentOn }),
    ...provenance(draft, settlementCurrency),
  };
}

/** `edit-expense` is `add-expense` re-validated the same way, keyed by the
 *  expense rather than the group — so the input is the same one, minus the
 *  group and plus the id. */
export function editExpenseInput(
  draft: ExpenseDraft,
  verdict: DraftVerdict,
  settlementCurrency: string
): Record<string, unknown> {
  const { group_id: _group, ...rest } = addExpenseInput(
    draft,
    verdict,
    settlementCurrency
  );
  return { expense_id: String(draft.expenseId), ...rest };
}

export interface SettleVerdict {
  ok: boolean;
  refusal?: string;
  amountMinor: number | null;
  /** Is the owner a party to this payment at all? A settlement between two
   *  other people changes a balance and writes no ledger entry, which the
   *  surface says out loud. */
  yours: boolean;
}

export function settleVerdict(
  draft: SettleDraft,
  me: string | null
): SettleVerdict {
  const amountMinor = parseMoney(draft.amount);
  const yours = me !== null && (draft.fromId === me || draft.toId === me);
  const refuse = (refusal: string): SettleVerdict => ({
    ok: false,
    refusal,
    amountMinor,
    yours,
  });
  if (draft.fromId === "" || draft.toId === "") return refuse(REFUSALS.parties);
  if (draft.fromId === draft.toId) return refuse(REFUSALS.same);
  if (amountMinor === null || amountMinor === 0) return refuse(REFUSALS.amount);
  return { ok: true, amountMinor, yours };
}

/** Exactly what `settle-up` declares. `group_id` is genuinely optional there,
 *  which is why *No group* is a real choice on this one surface and a stated
 *  gap on the other. */
export function settleInput(
  draft: SettleDraft,
  verdict: SettleVerdict
): Record<string, unknown> {
  return {
    from_party: draft.fromId,
    to_party: draft.toId,
    amount_minor: Number(verdict.amountMinor),
    ...(draft.groupId === NO_GROUP ? {} : { group_id: draft.groupId }),
    ...(draft.paidOn === "" ? {} : { paid_on: draft.paidOn }),
  };
}

/** A fresh expense draft, standing on what the room already knows: the group
 *  the member is looking at, the owner as payer, today's date. */
export function newExpenseDraft(seed: {
  groupId: string | null;
  payerId: string;
  today: string;
  currency: string;
}): ExpenseDraft {
  return {
    description: "",
    amount: "",
    payerId: seed.payerId,
    groupId: seed.groupId,
    category: "general",
    spentOn: seed.today,
    foreign: false,
    currency: seed.currency,
    rate: "",
    rateSource: "",
    rateDate: seed.today,
    division: "equal",
    entries: {},
  };
}

/**
 * An expense that already exists, as a draft the editor can open pre-filled.
 *
 * THE DIVISION IS `exact`, ALWAYS, and that is the honest choice: the vault
 * stores an expense's shares, not the rule that produced them, so re-opening
 * one as "equally" would be a guess that quietly rewrites the shares the
 * moment the member changes the amount. Exact amounts is what is actually
 * known — the stored numbers, editable — and its own reconcile line then says
 * whether they still sum.
 */
export function draftFromEntry(entry: {
  expense_id: string;
  group_id: string;
  description?: string;
  amount_minor: number;
  original_amount_minor: number;
  original_currency: string;
  settlement_currency: string;
  rate_scaled: number;
  rate_scale: number;
  rate_source: string;
  rate_date?: string;
  category?: string;
  spent_on?: string;
  paid_by: string;
  splits: readonly { party_id: string; share_minor: number }[];
}): ExpenseDraft {
  const foreign = entry.original_currency !== entry.settlement_currency;
  const entries: Record<string, string> = {};
  for (const split of entry.splits)
    entries[split.party_id] = (split.share_minor / 100).toFixed(2);
  return {
    expenseId: entry.expense_id,
    description: entry.description ?? "",
    amount: (
      (foreign ? entry.original_amount_minor : entry.amount_minor) / 100
    ).toFixed(2),
    payerId: entry.paid_by,
    groupId: entry.group_id,
    category: entry.category ?? "general",
    spentOn: entry.spent_on ?? "",
    foreign,
    currency: entry.original_currency,
    rate: foreign ? String(entry.rate_scaled / 10 ** entry.rate_scale) : "",
    rateSource: foreign ? entry.rate_source : "",
    rateDate: entry.rate_date ?? "",
    division: "exact",
    entries,
  };
}

export function newSettleDraft(seed: {
  fromId: string;
  toId: string;
  groupId: string | null;
  today: string;
}): SettleDraft {
  return {
    fromId: seed.fromId,
    toId: seed.toId,
    amount: "",
    groupId: seed.groupId,
    paidOn: seed.today,
  };
}
