// THE IDENTITY CORPUS — packages/design's three presentation answers, as data
// (#1020, D-1020-T1).
//
// `contracts/apps/tally/queries.json` carries a party's `color` from
// `partyHueValue(partyHueKey(id))`, its `initials` from `identityInitials`, and
// a figure's tone from `figureTone` — three functions with no Rust home, which
// is why wave 2 committed the 29 Tally cases and could not compare them (lane
// D3's receipt, D-1020-D3-9). The answer is not to retype them in Rust: it is
// to run THEM over a fixed input corpus and commit inputs and outputs, so
// `crates/design` is checked against the functions rather than against a
// reading of them.
//
// CALLED BY `export-native-theme.ts`, so one command emits every design
// artifact; runnable alone for a quick regeneration.
//
//   bun contracts/tools/export-design-corpus.ts
//   bun run format && git diff --exit-code design

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// `figureTone` lives with Tally's formatters rather than in `packages/design`
// (`packages/blueprints/apps/tally/format.ts:37`) because the sign convention
// it expresses is the app's. It is emitted here with the two design functions
// for one reason: it is the third PRESENTATION field the Tally parity fixture
// carries, and `crates/design` is the one place a presentation rule is lowered
// into Rust.
import { figureTone } from "../../packages/blueprints/apps/tally/format.ts";
import {
  identityInitials,
  partyHueKey,
  partyHueValue,
} from "../../packages/design/src/index.ts";
import { BRAND } from "../../packages/design/src/themes/shared.ts";

//
// THE THREE PRESENTATION FIELDS THE PARITY FIXTURES CARRY (#1020, D-1020-T1).
//
// `contracts/apps/tally/queries.json` carries a party's `color` from
// `partyHueValue(partyHueKey(id))`, its `initials` from `identityInitials`, and
// a figure's tone from `figureTone` — three functions with no Rust home, which
// is why the 29 cases were committed and not compared (wave 2 lane D3's
// receipt, D-1020-D3-9). The answer is not to retype them: it is to run THEM
// over a fixed input corpus and commit inputs and outputs, so `crates/design`
// is checked against the functions rather than against a reading of them.
//
// The corpus is deliberately hostile: non-ASCII names, an empty name, a
// whitespace-only name, a name that is one emoji, ids that are single
// characters and ids that are long, and every shape of stored `avatar_color`
// `partyHueKey` distinguishes.
//
// INITIALS TRAVEL AS UTF-16 CODE UNITS AS WELL AS TEXT, and that is a FINDING
// rather than a convenience: `identityInitials` slices with `String.slice(0,
// 1)`, which cuts a UTF-16 code unit, so a name whose first character is
// outside the BMP ("🙂 Smith") yields HALF A SURROGATE PAIR — a string no
// other language can represent and no font can draw. The corpus records the
// units so a port can prove it reproduces v0 exactly, and the receipt records
// the bug.

const CORPUS_IDS: readonly string[] = [
  "id-0001",
  "id-0002",
  "id-0003",
  "id-0004",
  "a",
  "z",
  "A",
  "",
  " ",
  "  spaced  ",
  "party:01JQ8ZQ0Y3K9WYD4V6N7M2B5XC",
  "0",
  "00000000-0000-0000-0000-000000000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
  "Ana",
  "Ana Díaz",
  "李明",
  "Ω",
  "🙂",
  "🙂🙂",
  "user@example.test",
  "a-very-long-party-identifier-that-keeps-going-and-going-0123456789",
  " ",
  "\t",
];

const CORPUS_AVATAR_COLORS: readonly (string | null | undefined)[] = [
  undefined,
  null,
  "",
  "   ",
  "var(--c-teal)",
  "var(--c-violet)",
  "var(--c-not-a-hue)",
  "#8c4c61",
];

const CORPUS_NAMES: readonly string[] = [
  "You",
  "Someone",
  "Friend",
  "Ana",
  "Ana Díaz",
  "ana díaz",
  "Bo",
  "Cleo",
  "Priya Raman",
  "  Priya   Raman  ",
  "María-José de la Cruz",
  "Jean-Luc",
  "李 明",
  "李明",
  "Ω Ψ",
  "🙂 Smith",
  "🙂",
  "Smith 🙂",
  "",
  " ",
  "   ",
  "\t\n",
  " Ana ",
  "d'Angelo",
  "van der Berg",
  "O'Neill McTavish",
  "x",
  "X y",
  "a b c d",
  "ANA",
];

const CORPUS_FIGURES: readonly number[] = [
  0, 1, -1, 2, -2, 99, -99, 100, -100, 1_000, -1_000, 10_001, -10_001, 4_200,
  -4_200, 8_333, -8_333, 2_147_483_647, -2_147_483_648, 5_000, -5_000, 1_333,
  -1_333, 8_416, -8_416, 24_000, -24_000, 3_500, -3_500, 12,
];

/** The code units of a string, so a lone surrogate survives the fixture. */
const codeUnits = (value: string): number[] =>
  Array.from({ length: value.length }, (_, at) => value.charCodeAt(at));

const hues = CORPUS_IDS.flatMap((partyId) =>
  CORPUS_AVATAR_COLORS.map((avatarColor) => {
    const key =
      avatarColor === undefined
        ? partyHueKey(partyId)
        : partyHueKey(partyId, avatarColor);
    return {
      party_id: partyId,
      // `undefined` and a missing key are the same call in JS and two
      // different values in JSON, so the absent argument is spelled.
      avatar_color: avatarColor === undefined ? null : avatarColor,
      avatar_color_absent: avatarColor === undefined,
      hue_key: key,
      color: key === null ? null : partyHueValue(key),
    };
  })
);

const initials = CORPUS_NAMES.map((name) => {
  const answer = identityInitials(name);
  // A LONE SURROGATE IS NOT JSON TEXT. `JSON.stringify` escapes it to
  // `"\ud83d"`, which every strict reader — `serde_json` included — refuses,
  // so the answer travels as units and `initials` is null exactly when v0's
  // own answer is unrepresentable. That the field can be null IS the finding.
  const wellFormed = !/\p{Surrogate}/u.test(answer);
  return {
    name,
    initials: wellFormed ? answer : null,
    units: codeUnits(answer),
  };
});

const tones = CORPUS_FIGURES.map((netMinor) => ({
  net_minor: netMinor,
  tone: figureTone(netMinor),
}));

/** Emit `design/identity-corpus.json`. Returns the row counts. */
export function emitIdentityCorpus(repositoryRoot: string): {
  hues: number;
  initials: number;
  tones: number;
} {
  mkdirSync(path.join(repositoryRoot, "design"), { recursive: true });
  writeFileSync(
    path.join(repositoryRoot, "design/identity-corpus.json"),
    `${JSON.stringify(
      {
        $generatedBy: "contracts/tools/export-design-corpus.ts",
        $note:
          "Inputs and outputs of packages/design's partyHueKey/partyHueValue " +
          "and identityInitials, and of Tally's figureTone, run over a fixed " +
          "corpus so crates/design is asserted against the functions rather " +
          "than against a reading of them (#1020, D-1020-T1). `initials.units` " +
          "are UTF-16 code units: identityInitials can answer half a surrogate " +
          "pair, and a port has to reproduce that exactly.",
        brand: BRAND,
        hues,
        initials,
        tones,
      },
      undefined,
      2
    )}\n`
  );

  return { hues: hues.length, initials: initials.length, tones: tones.length };
}

if (import.meta.main) {
  const counts = emitIdentityCorpus(new URL("../..", import.meta.url).pathname);
  console.error(
    `emitted design/identity-corpus.json (${counts.hues} hue rows, ` +
      `${counts.initials} initials rows, ${counts.tones} tone rows)`
  );
}
