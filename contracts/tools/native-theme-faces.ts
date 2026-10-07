// THE NATIVE FACES — which `.ttf` draws each ramp weight, and the PostScript
// name read out of each file (#1020, D-1020-E6).
//
// Split out of `export-native-theme.ts`, which imports `FACES` and
// `postScriptName` from here and does the byte copy itself; nothing in this
// module touches the filesystem except `postScriptName`'s read of one font.

import { readFileSync } from "node:fs";

// EVERY TYPE TOKEN HAS SAID `family: "sans"` SINCE THE FIRST ONE, AND NEITHER
// NATIVE SHELL HAS EVER DRAWN IT. SwiftUI asked for `.system(...)` and got SF
// Pro; Compose set no `fontFamily` and got Roboto. The word "sans" resolved to
// whatever Apple and Google happened to ship, on a screen the design system is
// supposed to own down to the line box — and nothing failed, which is exactly
// how it survived the project's whole life unnoticed.
//
// The only faces in the tree were `packages/design/fonts/*.woff2`: Latin
// subsets in a WEB container that neither `UIFont` nor Android's resource
// compiler can open. So the `.ttf` faces now sit beside them — the upstream
// SemiBold and the derived 470 the note further down explains, with that
// directory's README carrying the pinned upstream commit, the instancing
// command and the OFL — and THIS emitter is what carries them across, the same
// road the colour table takes, for the same reason. A face copied into two app
// trees by hand is two more untracked copies of a `packages/design` fact, which
// is census §E seam 11 again.
//
// What crosses is BYTES and NAMES:
//
//   * the `.ttf` itself, copied verbatim into `mobile/iosApp/Resources/Fonts/`
//     and `mobile/androidApp/src/main/res/font/`. Android resource names must
//     be lowercase snake_case or `aapt2` refuses the file outright, so the
//     Android copy is renamed and the iOS copy keeps the source filename.
//   * the PostScript name, READ FROM THE TTF'S OWN `name` TABLE rather than
//     guessed from the filename. `UIFont(name:size:)` matches on the PostScript
//     name and returns nil — silently — for anything else, and "the filename
//     without its extension" is a convention, not a guarantee. Guessing here
//     would have reproduced the silent-fallback defect one layer down.
//
// `code` is deliberately NOT in this table. It is the platform's own monospace
// on both shells, ships no file, and the absence is what says so.

export interface Face {
  /**
   * THE RAMP'S WEIGHT, NOT THE FILE'S. These are the only two values
   * `NativeTypeStyle.weight` ever holds, and they are what the emitted tables
   * key on; see the 470 note below for the one row where the two disagree.
   */
  readonly weight: number;
  /** The upstream filename, which is also the iOS bundle resource name. */
  readonly file: string;
  /** Lowercase snake_case, because `aapt2` accepts nothing else. */
  readonly androidResource: string;
}

// THE 400 REGISTER IS DRAWN BY A 470 FACE, AND ONLY HERE (decisions.md, ruled
// 2026-08-19, restored for these shells 2026-09-22 under #1029).
//
// This is a LOWERING AND NOT A THIRD WEIGHT, so read the table below carefully:
// the `weight` of the first sans row is `400` and stays `400`, because that is
// what the ramp says and what every emitted `NativeTypeStyle.weight` carries.
// What the row changes is which FILE that register resolves to. DESIGN.md
// specifies two weights; nothing in the ramp may name a 470, and nothing does —
// grep the emitted Kotlin and Swift tables and the only 470 you will find is
// inside a filename.
//
// The reason is the touch step this very emitter applies. `NATIVE_DELTA_BY_FAMILY`
// concedes that the phone needs +2px size and +3px leading over a desktop pane
// at the same role, and that step scales the GLYPH without scaling the stroke's
// optical presence; iOS compounds it, because CoreText draws with grayscale
// antialiasing where a desktop browser gets stem darkening. Same token, same
// face, objectively lighter strokes on the device — so a true 400 reads correct
// at a desk and THIN in the hand, and no edit to the shared ramp could fix one
// without wrecking the other. 500 was measured and overshot; 470 sits about
// three-quarters of the way from 400 to 500 in ink coverage.
//
// WEB AND DESKTOP ARE UNTOUCHED. `scripts/site-tokens.mjs` and
// `toFontFaceCss()` lower the same tokens against the `.woff2` subsets at
// weight 400, and they must keep doing so: the gallery depicts the ramp's
// specification and the device now deliberately differs from it on this one
// axis. A change here that reached the CSS would be the bug.
//
// The 400 static is NOT in `packages/design/fonts` any more, because after this
// row nothing anywhere renders it — the web reads woff2, and native reads the
// two files named below.
export const FACES: Readonly<Record<string, readonly Face[]>> = {
  sans: [
    {
      weight: 400,
      file: "InstrumentSans_470Book.ttf",
      androidResource: "instrument_sans_book",
    },
    {
      weight: 600,
      file: "InstrumentSans-SemiBold.ttf",
      androidResource: "instrument_sans_semibold",
    },
  ],
};

/**
 * THE POSTSCRIPT NAME, OUT OF THE FONT ITSELF.
 *
 * An OpenType `name` table is a run of records keyed by (platform, encoding,
 * language, nameID); nameID 6 is the PostScript name. Both platform 3 (Windows,
 * UTF-16BE) and platform 1 (Macintosh, MacRoman) records are accepted because
 * a font may carry either; the Windows one wins when both are present, since it
 * is the one modern tooling writes.
 *
 * Hand-rolled rather than pulled from a font library: this is forty lines of
 * big-endian struct reading against a format that has not changed since 1991,
 * and a dependency that runs at emit time is a dependency in the drift gate.
 */
export const postScriptName = (file: string): string => {
  const bytes = readFileSync(file);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tableCount = view.getUint16(4);
  let nameOffset: number | undefined;
  for (let index = 0; index < tableCount; index += 1) {
    const record = 12 + 16 * index;
    const tag = String.fromCharCode(
      ...[0, 1, 2, 3].map((byteIndex) => view.getUint8(record + byteIndex))
    );
    if (tag === "name") nameOffset = view.getUint32(record + 8);
  }
  if (nameOffset === undefined) throw new Error(`no name table: ${file}`);
  const recordCount = view.getUint16(nameOffset + 2);
  const stringOffset = view.getUint16(nameOffset + 4);
  let found: string | undefined;
  for (let index = 0; index < recordCount; index += 1) {
    const record = nameOffset + 6 + 12 * index;
    const platform = view.getUint16(record);
    const nameId = view.getUint16(record + 6);
    if (nameId !== 6) continue;
    const length = view.getUint16(record + 8);
    const offset = nameOffset + stringOffset + view.getUint16(record + 10);
    const slice = bytes.subarray(offset, offset + length);
    const value =
      platform === 3
        ? new TextDecoder("utf-16be").decode(slice)
        : new TextDecoder("latin1").decode(slice);
    if (platform === 3) return value;
    found ??= value;
  }
  if (found === undefined) throw new Error(`no PostScript name: ${file}`);
  return found;
};
