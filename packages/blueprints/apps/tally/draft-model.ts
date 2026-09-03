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

export const RATE_SCALE = 6;

export const NO_GROUP = null;

export interface ExpenseDraft {
  expenseId?: string;
  description: string;
  amount: string;
  payerId: string;
  groupId: string | null;
  category: string;
  spentOn: string;
  foreign: boolean;
  currency: string;
  rate: string;
  rateSource: string;
  rateDate: string;
  division: Division;
  entries: Record<string, string>;
  payers: Record<string, string>;
  lines: LineDraft[];
}

export interface SettleDraft {
  fromId: string;
  toId: string;
  amount: string;
  groupId: string | null;
  paidOn: string;
}

export const parseMoney = parseMoneyText;

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

export function settlementMinor(draft: ExpenseDraft): number | null {
  const original = parseMoney(draft.amount);
  if (original === null) return null;
  if (!draft.foreign) return original;
  const rate = parseRate(draft.rate);
  if (rate === null) return null;
  return Math.round((original * 10 ** rate.rate_scale) / rate.rate_scaled);
}

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

export function paidTotal(rows: readonly { paid_minor: number }[]): number {
  return rows.reduce((sum, row) => sum + row.paid_minor, 0);
}

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
  refusal?: string;
  allocation?: Allocation;
  splits: Share[];
  payers: { party_id: string; paid_minor: number }[];
  lineItems: LineItemInput[];
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

export function expenseVerdict(
  draft: ExpenseDraft,
  participants: readonly string[],
  currency: string,
  me: string | null = null,
  money: (minor: number, code: string) => string = (minor) =>
    (minor / 100).toFixed(2)
): DraftVerdict {
  const amountMinor = settlementMinor(draft);
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

function splitParams(draft: ExpenseDraft): Record<string, unknown> {
  const unit = divisionSpec(draft.division).unit;
  if (unit === "derived" || unit === "lines") return {};
  const entries = entryValues(draft.division, draft.entries);
  return { split_params: { unit, entries } };
}

export function addExpenseInput(
  draft: ExpenseDraft,
  verdict: DraftVerdict,
  settlementCurrency: string
): Record<string, unknown> {
  return {
    ...(draft.groupId === NO_GROUP ? {} : { group_id: draft.groupId }),
    description: draft.description.trim(),
    amount_minor: Number(verdict.amountMinor),
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
