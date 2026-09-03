import { money } from "./format.ts";

export type Division =
  | "equal"
  | "exact"
  | "percent"
  | "shares"
  | "adjust"
  | "lines";

export type DivisionUnit = "derived" | "money" | "percent" | "shares" | "lines";

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
  method: SplitMethod;
  unit: DivisionUnit;
}

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

export interface Share {
  party_id: string;
  share_minor: number;
}

export interface Entry {
  party_id: string;
  value: number;
}

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
  amountMinor: number;
  participants: readonly string[];
  payerId: string;
  entries: Readonly<Record<string, number>>;
  currency: string;
}

export interface Allocation {
  shares: Share[];
  ok: boolean;
  balanced: boolean;
  line: string;
}

function valueOf(input: AllocationInput, partyId: string): number {
  const raw = input.entries[partyId];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

function typedShares(input: AllocationInput): Share[] {
  return input.participants.map((party_id) => ({
    party_id,
    share_minor: Math.round(valueOf(input, party_id)),
  }));
}

function sumOf(shares: readonly Share[]): number {
  return shares.reduce((sum, share) => sum + share.share_minor, 0);
}

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

export function prefill(
  division: Division,
  amountMinor: number,
  participants: readonly string[],
  payerId: string
): Record<string, number> {
  const unit = divisionSpec(division).unit;
  const out: Record<string, number> = {};
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
