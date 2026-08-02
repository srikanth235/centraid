# Product grammar screenshot gallery

The gallery is the visual counterpart to `tests/design-grammar-matrix.json`. Run `bun run design:gallery -- --update` when a deliberate contract change updates the committed baselines; run `bun run design:gallery` to capture into `artifacts/design-gallery/actual` and compare RGBA pixels against the committed files.

The served-blueprint (`BS`) lane exercises all eight app identities and both theme profiles against the generated served lowering. The current system apps are inline-first, so the old visual harness's app index is intentionally a blank marker; the gallery uses a deterministic served-contract fixture instead of committing blank screenshots. The inline (`BI`) and compact shell (`SH-c`) lanes render their generated lowerings in the same fixture. The `MO-advisory` lane is a fixed-size native contract fixture: native simulator screenshots remain advisory, while the same reference state is covered by the typed `toNativeTheme()` tests and the fixture's geometry.

Baselines are intentionally committed under this directory. Generated actuals, reports, and browser traces stay under the ignored `artifacts/` directory.
