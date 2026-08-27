// THE GENERATOR, AS A PURE MODEL (README-Locker §5, "Generator"; GAPS §3.3
// #12 — words and PIN are client-only, and need no backend at all).
//
// A route of its own exists because someone who wants a string should not have
// to invent an item to get one. Nothing here writes: the output is a secret
// NOBODY HAS SAVED, which is why it lives in the orchestrator's `SecretBag`
// (`generated`) and is wiped by the same lock that wipes a reveal.
//
// LOOK-ALIKES ARE EXCLUDED ALWAYS, in every mode — not as an option a member
// can switch off, because a password read off a screen and typed on a keypad
// has to be the same password. The character pool is `totp.ts`'s
// `genPassword`, which already omits I, O, l, o, 0 and 1; the word list below
// is chosen the same way (no word that reads as another when hyphenated).
//
// Randomness is `crypto.getRandomValues` here as it is there. `Math.random`
// would be a generator that produces a secret nobody can rely on, which is
// worse than no generator.

import { genPassword } from "./totp.ts";

/** The three kinds the Kind row offers. */
export type GenKind = "chars" | "words" | "pin";

/** The Length row's chips. The recipe's range is 12–40 (README-Locker §5);
 *  see `gen-model.test.ts` for why nothing below 12 is offered. */
export const GEN_LENGTHS: readonly number[] = [12, 16, 20, 28, 40];

/** A PIN is a keypad's secret, and a keypad's secret is short. Longer than
 *  this is a password, and the Kind row already has one of those. */
export const PIN_MAX = 12;

/** What the three chip rows currently say. Not secret — the OUTPUT is. */
export interface GenOptions {
  kind: GenKind;
  length: number;
  digits: boolean;
  symbols: boolean;
}

export function defaultGenOptions(): GenOptions {
  return { kind: "chars", length: 20, digits: true, symbols: true };
}

/**
 * The word list. Short, common, unambiguous when spoken, and free of any pair
 * that reads as another at a glance — the same rule the character pool
 * follows. It is deliberately small and deliberately English: a list nobody
 * can read out loud is a list nobody will use, and a passphrase's strength
 * comes from the count of words drawn, which the length row controls.
 */
const WORDS: readonly string[] = [
  "anchor",
  "amber",
  "arbour",
  "autumn",
  "beacon",
  "bracken",
  "brindle",
  "cabin",
  "cedar",
  "chapel",
  "cinder",
  "clover",
  "compass",
  "coral",
  "cotton",
  "crescent",
  "damson",
  "dapple",
  "dawn",
  "delta",
  "drift",
  "ember",
  "estuary",
  "falcon",
  "fathom",
  "fennel",
  "ferry",
  "forge",
  "fossil",
  "garnet",
  "gable",
  "granite",
  "harbour",
  "hazel",
  "heather",
  "hollow",
  "isthmus",
  "juniper",
  "kestrel",
  "lantern",
  "larch",
  "lattice",
  "linnet",
  "marble",
  "meadow",
  "mercury",
  "mistral",
  "moorland",
  "nettle",
  "ninety",
  "nutmeg",
  "orchard",
  "otter",
  "paddock",
  "pebble",
  "pewter",
  "pillar",
  "quarry",
  "quince",
  "rafter",
  "reeds",
  "ripple",
  "rowan",
  "saffron",
  "sandbar",
  "sapling",
  "shale",
  "shutter",
  "sparrow",
  "spindle",
  "starling",
  "sterling",
  "sundial",
  "tangent",
  "teasel",
  "thistle",
  "thorn",
  "timber",
  "trellis",
  "tundra",
  "umber",
  "verdant",
  "vessel",
  "wander",
  "warbler",
  "wharf",
  "willow",
  "winnow",
  "yarrow",
];

/** One uniform draw from `count`, without modulo bias. */
function pick(count: number): number {
  const limit = Math.floor(0x1_0000_0000 / count) * count;
  const buffer = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    const value = buffer[0] ?? 0;
    if (value < limit) return value % count;
  }
}

/** Digits only, for a lock that takes nothing else. */
function genPin(length: number): string {
  const digits = Math.max(4, Math.min(PIN_MAX, length));
  let out = "";
  for (let index = 0; index < digits; index += 1) out += String(pick(10));
  return out;
}

/** Words joined by a hyphen, until the target length is met. Three at least:
 *  two words is a phrase anybody can guess the shape of. */
function genWords(length: number): string {
  const parts: string[] = [];
  while (parts.length < 3 || parts.join("-").length < length) {
    parts.push(WORDS[pick(WORDS.length)] ?? "");
  }
  return parts.join("-");
}

/**
 * One string, in the kind that was asked for. `length` means characters for
 * two of the three kinds and DIGITS for a PIN — which is why the note under
 * the row says so rather than leaving a member to work it out from an output
 * that came back shorter than the chip they pressed.
 */
export function generate(options: GenOptions): string {
  if (options.kind === "pin") return genPin(options.length);
  if (options.kind === "words") return genWords(options.length);
  return genPassword({
    len: Math.max(1, options.length),
    num: options.digits,
    sym: options.symbols,
  });
}

/** Which chip rows this kind actually reads. A row whose chips would change
 *  nothing is NOT drawn — a control with no effect teaches a member that the
 *  controls are decorative. */
export function readsInclude(kind: GenKind): boolean {
  return kind === "chars";
}

/** How the Length row is read, in this kind's own words. */
export function lengthMeaning(kind: GenKind): string {
  if (kind === "pin") return `digits, ${PIN_MAX} at most`;
  if (kind === "words") return "characters, in whole words";
  return "characters";
}
