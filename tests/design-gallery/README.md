# Product grammar screenshot gallery

The gallery is the visual counterpart to `tests/design-grammar-matrix.json`. Run `bun run design:gallery -- --update` when a deliberate contract change updates the committed baselines; run `bun run design:gallery` to capture into `artifacts/design-gallery/actual` and compare RGBA pixels against the committed files.

The served-blueprint (`BS`) lane exercises all eight app manifests and both theme profiles against the generated served lowering plus the live kit CSS. The inline (`BI`) and compact shell (`SH-c`) lanes use the same reference-state markup with their actual generated lowerings; the fixture is deliberately contract-shaped because the system apps' `index.html` files are listing markers and their React roots need the host runtime. The `MO-advisory` lane uses the concrete `toNativeTheme()` lowering to check native colors, geometry, reduced-motion, focus, and primary-action scarcity; simulator capture remains advisory.

Each entry records its source and covered moment IDs from `tests/design-grammar-matrix.json`. Verification fails on a stale manifest, missing renderable state, more than one primary action, or a non-focusable primary. `check:push` runs this lane, while `--update` is the only mode allowed to rewrite baselines and the manifest.

Baselines are intentionally committed under this directory. Generated actuals, reports, and browser traces stay under the ignored `artifacts/` directory.
