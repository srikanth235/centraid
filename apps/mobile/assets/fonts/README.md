# Bundled faces

One file lives here: `InstrumentSans_470Book.ttf`, the face the **400 register renders in on native**. Every other face the app loads comes from `@expo-google-fonts/instrument-sans` and is imported straight from the package.

## Why a file at all

`kit/theme/native.ts` carries the full reasoning; the short version is that `NATIVE_DELTA_BY_FAMILY` already concedes the phone needs +2px size and +3px leading over a desktop pane at the same role, and that step scales the glyph without scaling the stroke's optical presence. iOS compounds it — CoreText draws with grayscale antialiasing where a desktop browser gets stem darkening. The 400 register therefore reads correct at a desk and thin on the device.

This is a **lowering, not a third weight**. DESIGN.md still specifies two weights and nothing in the ramp may name a 470; this is only which file gets drawn when the lowering asks for 400 on a touch surface.

`@expo-google-fonts` cuts statics at 400/500/600/700 only. 500 was measured and judged to overshoot, so the shipped face is an intermediate instance.

## Provenance, and how to regenerate

Instrument Sans is © 2022 The Instrument Sans Project Authors, under the SIL Open Font License 1.1 (`OFL.txt`, copied verbatim from the upstream package). The licence carries **no Reserved Font Name**, so a derived instance may ship; this one declares `usWeightClass` 470 and names itself "Instrument Sans Book" so it cannot be mistaken for an upstream cut.

The canonical way to produce this file is to instance the upstream **variable** font, which applies the family's own nonlinear `avar` weight mapping:

```bash
fonttools varLib.instancer -o InstrumentSans_470Book.ttf \
  "InstrumentSans[wdth,wght].ttf" wght=470
```

**The file currently checked in was not produced that way.** No variable font is vendored in this repo and none was fetched, so it is a straight outline interpolation between the shipped 400 and 500 statics at t=0.70 — all 501 glyphs interpolated with zero incompatibilities, `hmtx` advances and sidebearings blended with them. That is faithful enough to judge and to ship, but it assumes the weight axis is linear between those two masters, which `avar` may say it is not. Regenerating from the upstream variable font is the one open follow-up; the file name, the `usWeightClass` and the family name above are what a regenerated file must keep so nothing else has to change.
