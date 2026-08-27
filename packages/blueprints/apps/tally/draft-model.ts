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
import { allocateByLine, lineItems } from "./line-model.ts";
import type { LineDraft, LineItemInput } from "./line-model.ts";
import { parseMoneyText, parseSignedMoneyText } from "./money-text.ts";
import {
  allocate,
  divisionOfMethod,
  divisionSpec,
  prefill,
} from "./split-model.ts";
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

/** `No group` is not a group id — it is the ABSENCE of one, and `add-expense`
 *  takes it: the expense is a group-less 1:1 and its participants are checked
 *  against the friend roster instead of a circle (GAPS.md Tally §4, ruled in).
 *  Held as its own value so the chip is one thing rather than an empty string
 *  standing in for a decision. */
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
  /** Who fronted it, and how much each of them put down — AS TYPED, for the
   *  same reason. Empty means the one payer named by `payerId` paid all of it,
   *  which is the ordinary case and the one the chip set starts in. */
  payers: Record<string, string>;
  /** The typed lines, when the division is *By line*. */
  lines: LineDraft[];
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
export const parseMoney = parseMoneyText;

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
    if (unit === "money") {
      out[partyId] = parseSignedMoneyText(text);
      continue;
    }
    const value = Number(text.trim());
    out[partyId] = Number.isFinite(value) ? value : 0;
  }
  return out;
}

/**
 * Who fronted the expense, in the shape `add-expense`'s `payers` requires.
 *
 * ONE PAYER IS THE ORDINARY CASE and it is not a special case: an empty payer
 * map resolves to the single named payer holding the whole amount, which is
 * exactly what the vault stores for a one-payer expense. Two people splitting
 * the bill at the till type their halves instead, and the sum is checked.
 */
export function payerRows(
  draft: ExpenseDraft,
  amountMinor: number
): { party_id: string; paid_minor: number }[] {
  const typed = Object.entries(draft.payers).filter(
    ([, text]) => text.trim() !== ""
  );
  if (typed.length === 0)
    return draft.payerId === ""
      ? []
      : [{ party_id: draft.payerId, paid_minor: amountMinor }];
  return typed.map(([party_id, text]) => ({
    party_id,
    paid_minor: parseMoney(text) ?? 0,
  }));
}

/** What the payers put down between them. */
export function paidTotal(rows: readonly { paid_minor: number }[]): number {
  return rows.reduce((sum, row) => sum + row.paid_minor, 0);
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
    out[partyId] = unit === "money" ? (value / 100).toFixed(2) : String(value);
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
  /** Who fronted it, resolved. */
  payers: { party_id: string; paid_minor: number }[];
  /** The typed lines the write would carry, when the division is *By line*. */
  lineItems: LineItemInput[];
  /** The expense in settlement minor units, where it can be worked out. */
  amountMinor: number | null;
}

export const REFUSALS = {
  description: "A description · it is what the expense will be called",
  amount: "An amount above zero",
  payer: "Who paid it",
  payersSum: "The payers put down more or less than the expense comes to",
  participants: "Someone to divide it between",
  rate: "The rate you read off the bill, as a number",
  currency: "A three-letter code for the currency it was entered in",
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
  currency: string,
  me: string | null = null,
  money: (minor: number, code: string) => string = (minor) =>
    (minor / 100).toFixed(2)
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
      : draft.division === "lines"
        ? allocateByLine({
            lines: draft.lines,
            amountMinor: amountMinor ?? 0,
            participants,
            me,
            currency,
            money,
          })
        : allocate({
            division: draft.division,
            amountMinor: amountMinor ?? 0,
            participants,
            payerId: draft.payerId,
            entries: entryValues(draft.division, draft.entries),
            currency,
          });
  const splits = allocation?.shares ?? [];
  const payers = payerRows(draft, amountMinor ?? 0);
  const items = draft.division === "lines" ? lineItems(draft.lines) : [];
  const refuse = (refusal: string): DraftVerdict => ({
    ok: false,
    refusal,
    ...(allocation ? { allocation } : {}),
    splits,
    payers,
    lineItems: items,
    amountMinor,
  });
  if (draft.description.trim() === "") return refuse(REFUSALS.description);
  if (parseMoney(draft.amount) === null || parseMoney(draft.amount) === 0)
    return refuse(REFUSALS.amount);
  if (draft.foreign && !/^[A-Za-z]{3}$/u.test(draft.currency.trim()))
    return refuse(REFUSALS.currency);
  if (draft.foreign && parseRate(draft.rate) === null)
    return refuse(REFUSALS.rate);
  if (payers.length === 0) return refuse(REFUSALS.payer);
  // WHAT WAS PUT DOWN IS THE EXPENSE. With one payer this can never fail; with
  // several it is the whole of the extra rule, and the vault re-validates it.
  if (paidTotal(payers) !== (amountMinor ?? 0))
    return refuse(REFUSALS.payersSum);
  if (participants.length === 0) return refuse(REFUSALS.participants);
  if (!allocation || !allocation.ok) return refuse(allocation?.line ?? "");
  return {
    ok: true,
    allocation,
    splits,
    payers,
    lineItems: items,
    amountMinor,
  };
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

/** The numbers a member typed, kept beside the shares they resolved to, so an
 *  edit re-opens the division rather than re-deriving it from the result.
 *  Empty for *Equally*, which has nothing typed, and for *By line*, whose
 *  typed values are the `line_items` themselves. */
function splitParams(draft: ExpenseDraft): Record<string, unknown> {
  const unit = divisionSpec(draft.division).unit;
  if (unit === "derived" || unit === "lines") return {};
  const entries = entryValues(draft.division, draft.entries);
  return { split_params: { unit, entries } };
}

/**
 * Exactly what `add-expense` declares, and nothing else.
 *
 * `group_id` IS OMITTED RATHER THAN NULLED on a group-less 1:1 — the schema
 * has it optional, and a `null` in an `additionalProperties:false` object is a
 * value the command would have to interpret rather than a field that is not
 * there.
 */
export function addExpenseInput(
  draft: ExpenseDraft,
  verdict: DraftVerdict,
  settlementCurrency: string
): Record<string, unknown> {
  return {
    ...(draft.groupId === NO_GROUP ? {} : { group_id: draft.groupId }),
    description: draft.description.trim(),
    amount_minor: Number(verdict.amountMinor),
    // The vault still records ONE `paid_by` for the row; with several payers
    // it is the one who put the most down, and `payers` carries the rest.
    paid_by: principalPayer(verdict.payers, draft.payerId),
    category: draft.category,
    splits: verdict.splits,
    payers: verdict.payers,
    split_method: divisionSpec(draft.division).method,
    ...splitParams(draft),
    ...(verdict.lineItems.length > 0 ? { line_items: verdict.lineItems } : {}),
    ...(draft.spentOn === "" ? {} : { spent_on: draft.spentOn }),
    ...provenance(draft, settlementCurrency),
  };
}

/** Whoever fronted the most of it. Ties keep the chip the member chose. */
export function principalPayer(
  payers: readonly { party_id: string; paid_minor: number }[],
  fallback: string
): string {
  let best = fallback;
  let most = -1;
  for (const payer of payers)
    if (payer.paid_minor > most) {
      most = payer.paid_minor;
      best = payer.party_id;
    }
  return best;
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
    payers: {},
    lines: [],
  };
}

/**
 * An expense that already exists, as a draft the editor can open pre-filled.
 *
 * THE DIVISION IS THE ONE THAT WAS RECORDED. `tally.add_expense` stores
 * `split_method` and `split_params` beside the shares, so re-opening an
 * expense re-opens the way it was entered — a percentage stays a percentage
 * and changing the amount re-divides it. An expense from before the method was
 * recorded, or one written by a method this build does not know, re-opens as
 * exact amounts: the stored numbers, editable, which is what is actually known.
 */
export function draftFromEntry(entry: {
  expense_id: string;
  group_id: string | null;
  description?: string;
  split_method?: string;
  split_params?: Record<string, unknown> | null;
  payers?: readonly { party_id: string; paid_minor: number }[];
  line_items?: readonly {
    line_item_id?: string;
    kind: "item" | "tax" | "tip";
    description: string;
    amount_minor: number;
    allocations: readonly { party_id: string }[];
  }[];
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
  const division = divisionOfMethod(entry.split_method);
  const entries = reopenEntries(division, entry);
  const payers: Record<string, string> = {};
  // ONE PAYER STAYS ONE PAYER. Re-opening a single-payer expense with its
  // payer row typed in would turn the ordinary case into the multi-payer form
  // on every edit, so the map is filled only where there really are several.
  if ((entry.payers?.length ?? 0) > 1)
    for (const payer of entry.payers ?? [])
      payers[payer.party_id] = (payer.paid_minor / 100).toFixed(2);
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
    division,
    entries,
    payers,
    lines: (entry.line_items ?? []).map((line, index) => ({
      lineId: line.line_item_id ?? `line-${index}`,
      kind: line.kind,
      description: line.description,
      amount: (line.amount_minor / 100).toFixed(2),
      who: line.allocations.map((allocation) => allocation.party_id),
    })),
  };
}

/**
 * The typed cells an edit re-opens with.
 *
 * The stored `split_params` carries what the member actually typed — the
 * percentages, the weights, the adjustments — so those come back as themselves.
 * Where there are none (an older expense, or *Equally*, which has nothing to
 * type) the stored SHARES are what is known, and they come back as amounts.
 */
function reopenEntries(
  division: Division,
  entry: {
    split_params?: Record<string, unknown> | null;
    splits: readonly { party_id: string; share_minor: number }[];
  }
): Record<string, string> {
  const unit = divisionSpec(division).unit;
  const stored = entry.split_params?.["entries"];
  if (
    unit !== "derived" &&
    unit !== "lines" &&
    stored &&
    typeof stored === "object"
  ) {
    const out: Record<string, string> = {};
    for (const [partyId, value] of Object.entries(
      stored as Record<string, unknown>
    ))
      out[partyId] =
        unit === "money"
          ? (Number(value) / 100).toFixed(2)
          : String(Number(value));
    return out;
  }
  const out: Record<string, string> = {};
  for (const split of entry.splits)
    out[split.party_id] = (split.share_minor / 100).toFixed(2);
  return out;
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
