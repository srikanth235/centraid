import { genPassword } from "./totp.ts";

export type GenKind = "chars" | "words" | "pin";

export const GEN_LENGTHS: readonly number[] = [12, 16, 20, 28, 40];

export const PIN_MAX = 12;

export interface GenOptions {
  kind: GenKind;
  length: number;
  digits: boolean;
  symbols: boolean;
}

export function defaultGenOptions(): GenOptions {
  return { kind: "chars", length: 20, digits: true, symbols: true };
}

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

function pick(count: number): number {
  const limit = Math.floor(0x1_0000_0000 / count) * count;
  const buffer = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    const value = buffer[0] ?? 0;
    if (value < limit) return value % count;
  }
}

function genPin(length: number): string {
  const digits = Math.max(4, Math.min(PIN_MAX, length));
  let out = "";
  for (let index = 0; index < digits; index += 1) out += String(pick(10));
  return out;
}

function genWords(length: number): string {
  const parts: string[] = [];
  while (parts.length < 3 || parts.join("-").length < length) {
    parts.push(WORDS[pick(WORDS.length)] ?? "");
  }
  return parts.join("-");
}

export function generate(options: GenOptions): string {
  if (options.kind === "pin") return genPin(options.length);
  if (options.kind === "words") return genWords(options.length);
  return genPassword({
    len: Math.max(1, options.length),
    num: options.digits,
    sym: options.symbols,
  });
}

export function readsInclude(kind: GenKind): boolean {
  return kind === "chars";
}

export function lengthMeaning(kind: GenKind): string {
  if (kind === "pin") return `digits, ${PIN_MAX} at most`;
  if (kind === "words") return "characters, in whole words";
  return "characters";
}
