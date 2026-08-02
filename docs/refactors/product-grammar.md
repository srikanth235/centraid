# Product grammar — semantic tokens, recipes, and cross-surface moments

**Issue:** #690 **Status:** initial migration complete; review closure in #695 **Owner session:** codex/issue-690-product-grammar

> Review correction: issue #690 established the v0 contract, but its original receipt overstated several enforcement claims. Follow-up issue #695 is the acceptance record for the review closure; this document is not evidence that a gate exists unless the code and tests named below provide it.

## Goal

Make the Product Grammar Constitution executable across the shell, compact shell, inline and served blueprints, mobile, and extension chrome. Done means that the semantic role registry, lowerings, recipes, icon/identity/formatter contracts, reference-state matrix, screenshot lanes, and regression fixes are all in the repository, with the existing gate loop green and the issue receipt linked.

## Safety argument

- The change is a pre-release design-contract migration: it changes presentation tokens and component vocabulary, not persisted data, protocol payloads, or vault semantics.
- CSS and native lowerings are generated from the same typed values. Mobile no longer parses CSS or applies a second runtime override layer; a generated-file test catches drift between `toNativeTheme()` and the checked-in module.
- The scaffolded blueprint `app.css` is a generated artifact. This is a v0 migration: the emitter and scaffold output move together, and stored apps from an older contract are explicitly outside this change rather than being given a compatibility alias layer. A future role rename must update the emitter, scaffold fixture, manifest/build output, and snapshots in one change; hand-editing a single served app would create a silent fork.
- The role registry is total over shell, blueprint, and native profiles. A role that cannot render is recorded as an explicit `unsupported` value, so missing declarations fail at typecheck/test time rather than becoming transparent UI.
- The matrix gates are seeded through the repository's demonstrated-red entries in `tests/matrix.json`; product-grammar D1–D7 are now executable gates and the main quality gate remains green.
- Existing app identity, network, consent, and replica write paths remain the owners of behavior. This work only routes their visible marks, containers, labels, and feedback through shared contracts.

## Plan

1. Establish the normative `DESIGN.md`, semantic roles, profiles, lowerings, native delta, target-size adapter, and contract tests.
2. Add the complete recipe registry and CSS recipe emitter; migrate default and action variants across shell, kit, blueprint, and mobile.
3. Consolidate icons, app/person identity, bytes/relative-time formatting, and mobile theme generation; remove Feather/CSS-parser split paths.
4. Migrate token consumers and extension chrome; close the named B1–B29 regressions that are in scope for this issue. **Initial implementation complete; review closure tracked in #695.**
5. Record the M1–M20 shared/adapted/local matrix and enumerated reference states; use it to drive visual gallery lanes and seeded quality gates. **Complete.**
6. Run package and repository gates, update this log and the issue receipt, then publish the branch as the issue PR. **Complete in this branch.**

## Progress log

| Date | Step | PR/commit | Notes |
| --- | --- | --- | --- |
| 2026-08-02 | 1–2 | — | Registry, profile lowerings, native theme, type scale, recipes, and contract tests landed in the working tree. |
| 2026-08-02 | 3 | — | Mobile CSS-parser path removed; shared icons, app catalog, identity helpers, and formatter helpers added; Feather call sites now use the shared adapter. |
| 2026-08-02 | 4 | — | Shell/blueprint/mobile/extension token migration complete; B1–B29 are closed, including host-owned appearance, identity/action separation, native pickers, upload/unpair feedback, icon validation, and token hard-zero gates. |
| 2026-08-02 | 5–6 | — | `tests/design-grammar-matrix.json` enumerates M1–M20, five surface lowerings, and 48 reference states; `scripts/design-gallery.mjs` verifies 22 committed baselines with RGBA diffs, and the focused/repository gates are recorded in the issue receipt. |
| 2026-08-02 | #695 | — | Review closure adds registry-backed lowerings, native equivalence/freshness checks, real kit-backed gallery lanes, mobile/extension token ratchets, and receipt corrections. |

## Rejected alternatives

| Idea | Why rejected |
| --- | --- |
| Keep separate shell, blueprint, and mobile token truth | It recreates the exact drift this issue targets; adapters belong at the lowering boundary. |
| Let app identity own `--accent` | Teal is the product action/selection signal; identity and action must remain independent. |
| Let each filled component choose its foreground | Contrast becomes a renderer-time guess and breaks the fill-ink contract. Fills publish solved ink roles. |
| Keep blueprint sun/moon toggles | Appearance is host-owned and per-device; app-local toggles mutate the surrounding shell and are unpersisted in served mode. |
| Continue parsing CSS variables in native | CSS is not a native contract and the parser/override path allowed silent divergence. `toNativeTheme()` is concrete and typed. |
| Advertise ⌘↵ “open in new window” without implementing it | A shortcut label is a behavior contract; the false palette hint was removed until a real action exists. |
| Build a new visual framework or add a runtime screenshot service | The repo already has Playwright and a blueprint visual harness; the gallery should be a small deterministic lane over those primitives. |

## Out of scope

- New product features, vault/protocol changes, or persisted-data migrations.
- Rewriting app-specific content layers such as charts, media artwork, prose rendering, capture confidence logic, or the glass material.
- Native simulator CI as a required PR lane; the mobile reference states are contract-tested and marked advisory for device capture.
- Migration or rewrite of stored pre-v0 vault `app.css` artifacts; v0 publishes the new generated contract atomically.
- Reintroducing retired compatibility aliases (`--brand`, `--bezel*`, CSS parser overrides, per-app theme ownership, or Feather as a glyph source).
