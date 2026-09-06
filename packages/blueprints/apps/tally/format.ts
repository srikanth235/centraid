// Pure, JSX-free formatting for Tally — the only place a derived number
// becomes a string.
//
// ONE SIGN CONVENTION FOR THE WHOLE APP (spec §2): **positive is owed to you,
// negative is owed by you**, so a figure never needs a legend. That convention
// is expressed exactly once, here, as `figureTone` — and every figure leaf in
// the room reads its tone from it rather than deciding locally what a minus
// sign means.
//
// NOTHING HERE DERIVES A BALANCE. Every `*_minor` argument arrives already
// folded by `queries/dashboard.ts`; these functions choose a word, an absolute
// value and a tone. Summing shares here would be a second engine.
import type { Money, MoneyBag, Valuation } from "@centraid/core/money";
import { fmtMoney, partyHueKey } from "@centraid/design";

import type { Role } from "./types.ts";

/** How a figure leaf is painted. `net` is the `--net` token — you owe;
 *  `owed` is plain ink — you are owed; `settled` is the recessive rung.
 *  NEVER a green: a settled balance is a fact, not a reward. */
export type FigureTone = "net" | "owed" | "settled";

/** The absolute amount; direction is carried by the words beside it, never by
 *  a minus sign. */
export function money(
  minor: number | null | undefined,
  currency: string | undefined
): string {
  return fmtMoney(Math.abs(Number(minor ?? 0)), currency);
}

/**
 * A net's tone, on the app's one convention. The dead band is a single minor
 * unit: a balance that rounds to nothing IS level, and a row reading "you owe
 * £0.00" in `--net` would be a warning about nothing.
 */
export function figureTone(netMinor: number): FigureTone {
  if (Math.abs(netMinor) < 1) return "settled";
  return netMinor < 0 ? "net" : "owed";
}

/** Is every balance in this set level? */
export function allSettled(nets: readonly number[]): boolean {
  return nets.every((net) => Math.abs(net) < 1);
}

/** The figure itself: an amount, or the word for a level balance. */
export function netFigure(
  netMinor: number,
  currency: string | undefined,
  settledWord = "settled"
): string {
  return figureTone(netMinor) === "settled"
    ? settledWord
    : money(netMinor, currency);
}

/** The sub-label under a PERSON's net — whose direction it runs in. */
export function personSubLabel(netMinor: number): string {
  const tone = figureTone(netMinor);
  if (tone === "settled") return "";
  return tone === "net" ? "you owe" : "owes you";
}

/** The sub-label under a GROUP's net. A group does not owe; the members do,
 *  so the phrasing is the owner's position in it. */
export function groupSubLabel(netMinor: number): string {
  const tone = figureTone(netMinor);
  if (tone === "settled") return "";
  return tone === "net" ? "you owe" : "owed to you";
}

/** The sub-label under a LEDGER ROW's figure — what the row's amount is to
 *  the owner. A row nobody put the owner in states that instead of a share. */
export function roleSubLabel(role: Role): string {
  if (role === "lent") return "your share";
  return role === "borrowed" ? "you owe" : "not yours";
}

/** A ledger row's figure tone. Fronting an expense leaves the owner owed, so
 *  it stays ink; owing a share of one is the `--net` case. */
export function roleTone(role: Role): FigureTone {
  if (role === "borrowed") return "net";
  return role === "lent" ? "owed" : "settled";
}

/** The person's point on the shared identity hue wheel, keyed by the stable
 *  party id. The wheel is the product's, not this app's — the same person is
 *  the same hue in People, Photos and here. */
export function personHue(partyId: string): string {
  // The `-text` rung of the ONE party hue (#883, ruling O-identity) — a
  // figure's ink, solved against the page, rather than the ring's fill.
  return `var(--c-${partyHueKey(partyId) ?? "slate"}-text)`;
}

/** A part the caller does not know DROPS OUT rather than leaving a dangling
 *  separator — which is why the type admits absence at all. */
export function metaSentence(
  parts: readonly (string | false | null | undefined)[]
): string {
  return parts.filter(Boolean).join("  ·  ");
}

/** A proportion, as a whole percentage of the largest row. Clamped, because a
 *  bar wider than its track is a rendering bug wearing a data costume. */
export function proportion(value: number, largest: number): number {
  if (largest <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((value / largest) * 100)));
}

// ── Money-typed figures (#996, ruling R22; drift ONT-23) ───────────────────
//
// The `(minor, currency)` pair above is how this file was called when the two
// travelled separately and a caller could pass either one of somebody else's.
// A balance is a `Money` now, so the currency arrives WITH the amount and the
// pairing cannot be got wrong; a position spanning currencies is several
// figures, joined, and never a sum.

/** The absolute amount of one `Money`, in its own currency. */
export function moneyFigure(value: Money): string {
  return money(value.amount_minor, value.currency);
}

export function moneyTone(value: Money): FigureTone {
  return figureTone(value.amount_minor);
}

/** One balance: its amount, or the word for a level one. */
export function moneyNetFigure(value: Money, settledWord = "settled"): string {
  return netFigure(value.amount_minor, value.currency, settledWord);
}

/**
 * A position across currencies, as SEVERAL figures. An empty bag is level; two
 * currencies read "€100.00  ·  $100.00", which is the whole of ONT-23's fix on
 * a surface: the two amounts are both true, and their sum is not.
 */
export function bagFigure(bag: MoneyBag, settledWord = "settled"): string {
  const live = bag.filter((amount) => Math.abs(amount.amount_minor) >= 1);
  if (live.length === 0) return settledWord;
  return live.map(moneyFigure).join("  ·  ");
}

/** The bag's tone: level when every amount is, `--net` when any is owed by the
 *  owner, plain ink otherwise. A mixed position leads with what is owed. */
export function bagTone(bag: MoneyBag): FigureTone {
  const live = bag.filter((amount) => Math.abs(amount.amount_minor) >= 1);
  if (live.length === 0) return "settled";
  return live.some((amount) => amount.amount_minor < 0) ? "net" : "owed";
}

/**
 * A hero figure. A `valued` valuation renders its total; an `unavailable` one
 * renders its components, because the several amounts are what is true when no
 * rate exists — never a sum nobody computed.
 */
export function valuationFigure(
  valuation: Valuation,
  settledWord = "settled"
): string {
  return valuation.state === "valued"
    ? moneyNetFigure(valuation.total, settledWord)
    : bagFigure(valuation.components, settledWord);
}

/** Whether a valuation could be one number at all — the sentence a surface
 *  needs before it puts a single figure under a single word. */
export function valuationIsOneFigure(valuation: Valuation): boolean {
  return valuation.state === "valued";
}

/** The absolute size of a valuation, for "is this level" questions only. */
export function valuationIsSettled(valuation: Valuation): boolean {
  return valuation.state === "valued"
    ? Math.abs(valuation.total.amount_minor) < 1
    : valuation.components.every((amount) => Math.abs(amount.amount_minor) < 1);
}

/** A hero's tone: the total's when there is one, the position's otherwise. */
export function valuationTone(valuation: Valuation): FigureTone {
  return valuation.state === "valued"
    ? moneyTone(valuation.total)
    : bagTone(valuation.components);
}

/** The sub-label under a friend's position, which may span currencies. A
 *  mixed position leads with what the owner owes, matching `bagTone`. */
export function bagSubLabel(bag: MoneyBag): string {
  const tone = bagTone(bag);
  if (tone === "settled") return "";
  return tone === "net" ? "you owe" : "owes you";
}
