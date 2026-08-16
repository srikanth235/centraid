# Product grammar screenshot gallery

The gallery is the visual counterpart to `tests/design-grammar-matrix.json`. Run `bun run design:gallery -- --update` when a deliberate contract change updates the committed baselines; run `bun run design:gallery` to capture into `artifacts/design-gallery/actual` and compare RGBA pixels against the committed files.

## What each lane photographs, and what it therefore claims

`SH` and `SH-c` are the **real built shell**. The script builds `apps/web`, serves the dist, and drives `#ui-preview` — the in-product component gallery `packages/client/src/react/boot.tsx` mounts — at the pointer and compact viewports. The pixels are the product's own React blocks under the product's own token lowering and its own self-hosted faces. Nothing in the capture is written by the gate script.

`BI` and `MO` are **token lowerings only**, and their baselines must not be read as anything else. `toBlueprintCss()` and `toNativeTheme()` are lowerings, not renderers: an inline blueprint app needs a gateway and a vault to paint, and a React Native surface has no DOM at all. Each lane renders a sheet of the lowering's own _resolved_ custom properties — every colour as a swatch, every value spelled out in full. That fences the real claim, "this lowering reaches this surface with the values the registry declares", and depicts nothing the platform does not emit. A baseline showing components a surface never renders would be worse than a narrower honest one. The manifest's `laneClaims` says the same thing beside the entries.

There is no `BS` lane. [Issue #799](https://github.com/srikanth235/centraid/issues/799) retired the served blueprint plane, so the surface it named no longer exists to photograph; its reference states moved to `BI` in the grammar matrix.

Before #799 every lane rendered a hand-written HTML fixture with a hand-written stylesheet — a second, invented component vocabulary living inside the gate script, photographed as if it were the product.

## The faces

Every lane loads the vendored Instrument Sans `.woff2` files through the same `FONT_FILES` manifest `apps/web`'s `centraid-fonts` plugin serves, and every capture fails loudly if the family does not actually resolve — `document.fonts.ready` alone settles just as happily when a face failed and the renderer fell back. The fixtures used to hardcode `system-ui`, which resolves to a different physical font per OS; that was the fidelity bug behind the cross-platform redness recorded in [#781](https://github.com/srikanth235/centraid/issues/781).

## Verification

Each entry records its source, lane and covered moment IDs from `tests/design-grammar-matrix.json`. Verification fails on a stale manifest, a matrix surface no lane captures, a missing renderable state, an unresolved product face, an illegal computed type triple, a missing button variant, an accent fill painted by any variant other than `primary`, or a non-focusable primary. `check:push` runs this lane, while `--update` is the only mode allowed to rewrite baselines and the manifest.

Baselines are intentionally committed under this directory. Generated actuals, reports, and browser traces stay under the ignored `artifacts/` directory.
