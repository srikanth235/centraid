# The font files

`packages/design/src/typography.ts` says every type role is `family: "sans"`, and "sans" has always meant Instrument Sans. This directory is the ONE SOURCE for the bytes behind that word — the web build reads the `.woff2` subsets, and `contracts/tools/export-native-theme.ts` copies the `.ttf` faces into `mobile/iosApp/Resources/Fonts/` and `mobile/androidApp/src/main/res/font/`. Nothing else fetches a face, and no shell may reference a font CDN (`docs/decisions.md:411`).

## What is here, and where it came from

| File | Source | Read by |
| --- | --- | --- |
| `InstrumentSans_470Book.ttf` | derived instance of `Instrument/instrument-sans` @ `7fa22308a3d0c94ee2b3cd537a1196b65db34a3e`, `fonts/variable/` — see below | iOS + Android, via the emitter, as the **400 register's face** |
| `InstrumentSans-SemiBold.ttf` | same commit, `fonts/ttf/` | iOS + Android, via the emitter, at 600 |
| `OFL.txt` | same commit, repository root | nobody — it SHIPS, which is the point |
| `instrument-sans-latin*-{400,600}-normal.woff2` | `@fontsource/instrument-sans@5.2.5` | the web build |

The upstream commit is pinned by SHA and not by branch because `master` is a moving target and a face that changes under us changes every measured line box in the product. `7fa2230` is the head of `master` as of 2023-06-14; the repo publishes no tagged release, which is why a commit and not a tag is recorded. The SemiBold static here is byte-identical to that commit's `fonts/ttf/InstrumentSans-SemiBold.ttf` (`7151cf505f897e17b4e9b956293b5a60046ec39da3923a8feba29ce86fd14e12`), and the variable font the 470 was cut from comes from the SAME commit (`b24f1812584816958afcf22e22d08e44318c5e51651e25d2438efdde389b33b1`) — one upstream state behind both files, so the two weights cannot be from two designs.

**THERE IS NO 400 STATIC HERE ANY MORE, and its absence is a decision.** The web surfaces read the `.woff2` subsets and never a `.ttf`; native draws the 470 at that register and the SemiBold at 600. After the lowering below, nothing in the product renders `InstrumentSans-Regular.ttf`, and a file in the ONE SOURCE directory that no consumer reads is an invitation to re-point something at it by mistake — which is the exact regression `FontRegistrationTests` now guards.

## The 470, and why the 400 register is not drawn by a 400 face

Ruled 2026-08-19 and restored for the KMP shells 2026-09-22 ([#1029](https://github.com/srikanth235/centraid/issues/1029)); the argument lives in `docs/decisions.md` and the mechanism in the emitter's own comment. The short version is that the native lowering already concedes the phone needs +2px size and +3px leading over a desktop pane at the same role, and that step scales the glyph without scaling the stroke's optical presence. iOS compounds it — CoreText draws with grayscale antialiasing where a desktop browser gets stem darkening. The 400 register therefore reads correct at a desk and thin on the device. 500 was measured and judged to overshoot.

This is a **lowering, not a third weight**. DESIGN.md still specifies two weights and nothing in the ramp may name a 470; the emitted `NativeTypeStyle.weight` stays `400` and only the file behind it changes. Web and desktop are untouched.

## Provenance, and how to regenerate

Instrument Sans is © 2022 The Instrument Sans Project Authors, under the SIL Open Font License 1.1 (`OFL.txt`, copied verbatim from upstream). The licence carries **no Reserved Font Name**, so a derived instance may ship; this one declares `usWeightClass` 470 and names itself "Instrument Sans Book" so it cannot be mistaken for an upstream cut. The OFL text covers the derived instance as it covers the statics — same licence, same family, and the derivation is recorded in the face's own `name` table (nameID 10) as well as here.

The face is cut from the upstream **variable** font, which is what applies the family's own weight mapping rather than assuming one:

```bash
# fontTools is NOT a repo dependency and must not become one. A throwaway venv
# outside the tree is the whole toolchain:
#   python3 -m venv /tmp/ft && /tmp/ft/bin/pip install fonttools
# and the variable font is fetched, not vendored — 194 KB of bytes no build step
# reads would be a fourth copy of a fact that already has a home upstream:
#   curl -sSL -o 'InstrumentSans[wdth,wght].ttf' \
#     'https://raw.githubusercontent.com/Instrument/instrument-sans/7fa22308a3d0c94ee2b3cd537a1196b65db34a3e/fonts/variable/InstrumentSans%5Bwdth,wght%5D.ttf'

fonttools varLib.instancer -o InstrumentSans_470Book.ttf \
  "InstrumentSans[wdth,wght].ttf" wght=470 wdth=100
```

`wdth=100` is the width axis PINNED AT ITS OWN DEFAULT (the axis runs 75–100 with a default of 100, i.e. upstream's uncondensed width), so the instance is weight-only and no width decision is smuggled in alongside the weight one. Leaving `wdth` unpinned would have left a variable axis in the shipped file, which is the thing the statics exist to avoid: neither `UIFont(name:size:)` nor Android's `R.font` will instantiate an axis off-default without per-platform variation plumbing.

`varLib.instancer` sets `usWeightClass` itself; the naming is a second pass, because an instancer's pruned `name` table still says "Instrument Sans / Regular" and a face that answers to the upstream family name is exactly what must not ship:

```python
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables import otTables as ot

f = TTFont("InstrumentSans_470Book.ttf")
for nid, value in {
    1: "Instrument Sans Book", 2: "Regular", 3: "1.000;NONE;InstrumentSans-Book",
    4: "Instrument Sans Book", 6: "InstrumentSans-Book",
    5: "Version 1.000; derived static instance of Instrument Sans at wght=470",
    10: "…derivation, command and upstream commit, in the font itself…",
}.items():
    f["name"].setName(value, nid, 3, 1, 0x409)   # Windows
    f["name"].setName(value, nid, 1, 0, 0)       # Macintosh
for nid in (16, 17):
    f["name"].removeNames(nameID=nid)            # they exist only to disagree with 1/2
f["OS/2"].usWeightClass = 470
# STAT lost its weight row — the instancer drops every axis value the instance
# does not sit on, and 470 is none of 400/500/600/700. A wght axis record with
# no value elides to the fallback name, i.e. reports itself as "Regular".
stat = f["STAT"].table
i = next(n for n, a in enumerate(stat.DesignAxisRecord.Axis) if a.AxisTag == "wght")
v = ot.AxisValue()
v.Format, v.AxisIndex, v.Flags, v.Value = 1, i, 0, 470.0
v.ValueNameID = f["name"].addName("Book")
stat.AxisValueArray.AxisValue.append(v)
stat.AxisValueCount = len(stat.AxisValueArray.AxisValue)
f.save("InstrumentSans_470Book.ttf")
```

Subfamily is `Regular`, not `Book`: nameID 2 is spec-restricted to Regular / Italic / Bold / Bold Italic, and the v0 file's `Book` there was invalid (it also produced the full name "Instrument Sans Book Book"). The distinguishing word lives in the FAMILY name, where it belongs and where every font menu, `UIFont.familyName` and `fc-list` will show it.

### Verification, read back out of the shipped bytes

The three things a regenerated file must keep, printed from the file in this directory:

```
filename          : InstrumentSans_470Book.ttf
OS/2.usWeightClass: 470
family (id 1)     : Instrument Sans Book
subfamily (id 2)  : Regular
full (id 4)       : Instrument Sans Book
PostScript (id 6) : InstrumentSans-Book
version (id 5)    : Version 1.000; derived static instance of Instrument Sans at wght=470
glyph count       : 501
variable axes left: False      (fvar dropped)
avar left         : False      (avar dropped)
sha256            : bf0b48e6e4c4b98b9b1fa88b8ed3baa3ae333524b91e020247dec11c107eeae1
```

The PostScript name is what iOS matches on, and the emitter reads it out of this very `name` table rather than guessing it from the filename — so the Swift table's `"InstrumentSans-Book"` is these bytes' own claim about themselves.

## The open question the v0 README raised, answered: `avar` changes nothing here

The face bundled with the v0 Expo app was NOT instanced from the variable font. It was a straight outline interpolation between the shipped 400 and 500 statics at t=0.70, and that README flagged the assumption it rests on — that the weight axis is linear between those two masters, which the family's `avar` table may say it is not. It is not an assumption any more. Read out of `InstrumentSans[wdth,wght].ttf` at the pinned commit:

- **`avar`'s `wght` segment is the identity map**, `{-1: -1, 0: 0, 1: 1}`. The table is not absent and not inert — it warps the WIDTH axis, mapping −0.48 to −0.5 — but it applies no warp whatsoever to weight. Pinning `wdth` at its default also puts the width axis at normalized 0, where even that warp is the identity.
- **`gvar` carries exactly one `wght` region**, a tent with peak and end at 1.0 and start at 0.0 — a single master at wght=700, with NO intermediate master at 500 or 600. The design space is therefore exactly linear in weight across the whole 400–700 range.

So the two methods target the same point in the design space, and the arithmetic agrees to the digit: the instancer's own log reports the normalized coordinate as `0.233337`, which is 70/300, and t=0.70 between the 400 and 500 statics is 0.70 × (100/300) = the same 70/300 of the single 400→700 delta. **The v0 file's linearity assumption was correct.** Measured against it, all that regenerating bought is the rounding:

| Comparison | New instance vs the v0 interpolation |
| --- | --- |
| Outline points identical | 3975 of 5507 (72.2%) |
| Largest coordinate deviation | **1 unit** at 1000 upm — 0.1% of an em, on every one of the remaining points |
| Advance widths differing | 46 of 501 glyphs, all by exactly 1 unit |
| Left side bearings differing | 18 of 501 glyphs, by at most 2 units |
| Summed glyph ink area over a sample string | 5 135 737 vs 5 134 636 — **0.021% apart** |

That is the floor: the statics carry integer coordinates, so interpolating two already-rounded masters and re-rounding cannot land on the same integer as rounding once from full-precision deltas, and no other source of difference exists. The regeneration is still the right file to ship — it is derived from the master the foundry publishes rather than from two of its outputs, it needs no argument about linearity to justify it, and the command above reproduces it — but the honest answer to "did `avar` make a difference" is **no, none, and the v0 face was optically correct**. What changed is the provenance, not the ink.

For scale against the thing the decision is actually about, measured the same way on the same sample:

| Face          | `l` stem width (1000 upm) | Summed ink area |
| ------------- | ------------------------- | --------------- |
| Regular, 400  | 80                        | 4 312 407       |
| **Book, 470** | **97**                    | **5 135 737**   |
| Medium, 500   | 104                       | 5 378 723       |
| SemiBold, 600 | 126                       | 6 397 267       |

71% of the way from 400 to 500 by stem and 77% by area, which is the "~73%" the 2026-08-19 ruling recorded, measured a different way and landing in the same place.

## The licence

Instrument Sans is licensed under the SIL Open Font License 1.1, which requires the licence text to travel with the font. `OFL.txt` is that text, verbatim from upstream, and it sits BESIDE the files it covers rather than in a licence manifest somewhere else — the obligation is on the bytes as they are redistributed, and the emitter redistributes them into two app bundles. The derived 470 is a Modified Version under that licence: permitted, because the family reserves no font name, and renamed anyway so that no reader can mistake it for the foundry's own work.
