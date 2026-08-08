# App scenario × layer admission template

Use this document when a bundled app graduates beyond sample data. Copy the blank sections into the app's design/measurement plan and replace every placeholder. The admission rule is **engines tested once, apps tested as deltas**: do not restate placement, custody, consent, triage, search, enrichment, replica, or frame behavior that already has a canonical engine owner.

## Admission checklist

- [ ] Name the app, its north star, seat class (`record-only` or `byte-bearing`), and graduation issue.
- [ ] Put pure product arithmetic in a `*-model.ts` module beside the view; renderers adapt it but do not recompute it.
- [ ] Give each scenario one cheapest falsifying layer: `U`, `C`, or `E`. Use `U + E` only when the assertions are genuinely different and state that split in the evidence cell.
- [ ] Add handler contracts for every vault-facing action, including refusal, receipt/postcondition, and partial-batch behavior where applicable.
- [ ] Record structurally impossible engine/app combinations as `skip` in `tests/matrix.json#appEngines`, with a reason and `docs/blueprint-seats.md#engine-contracts` citation.
- [ ] For a byte-bearing/graduated app, name one north-star journey per platform and a tighten-only budget file beside its flows. For a record-only app, cite the shared representative replica journey unless the app has an app-specific native integration.
- [ ] Reuse one seeded `@centraid/test-kit/year3-vault` profile per platform run. Put destructive/exclusive-state journeys first and make them restore/reseed the shared profile.
- [ ] Add the app directory to PR-time path filtering for its journey.
- [ ] Seed the app's own coverage floor from a measured run and remove its numerator/denominator from the non-graduated blend; document any measurement-driven down-only split as an approved deviation.

## Blank scenario table

`U` is a pure/unit test, `C` is an RNTL/Vitest component test, and `E` is one named platform journey. Replace every placeholder and delete unused rows.

| <App> scenario | U | C | E | Owner / evidence |
| --- | --- | --- | --- | --- |
| <pure product arithmetic> | ✅ | — | — | `<feature>-model.test.ts` |
| <native role/state/responder claim> | — | ✅ | — | `<Feature>.test.tsx` |
| <device/runtime integration claim> | — | — | ✅ | `<app>-<journey>.mjs` |
| <different arithmetic and runtime claims> | ✅ | — | ✅ | State exactly what the unit and journey each falsify. |

## Handler contracts

| Action | Happy-path receipt/postcondition | Refusal/partial failure | Owner |
| --- | --- | --- | --- |
| `<action>` | <observable vault result> | <observable refusal or isolated item failure> | `<handler>.contract.test.ts` |

## Structural exclusions

| Engine | Why structurally impossible | Matrix citation |
| --- | --- | --- |
| `<engine>` | <closed union, absent registry row, record-only/seat rule, or other structural fact> | `docs/blueprint-seats.md#engine-contracts` |

## Journey and budget ownership

| Platform | North-star journey | Shared seed/profile | Tighten-only budget file | PR path filter |
| --- | --- | --- | --- | --- |
| iOS | `<journey>.mjs` | `@centraid/test-kit/year3-vault` | `<app>-budget.md` | `<app directories>` |
| Android | `<journey>.mjs` | `@centraid/test-kit/year3-vault` | `<app>-budget.md` | `<app directories>` |

Record-only apps should cite the shared representative replica write/read/offline journey in both platform rows until an app-specific native integration creates a distinct claim.

## Photos reference instance (unchanged from #716)

The reference table below is reproduced unchanged from [`TESTING.md`](../../TESTING.md#photos-scenario--layer-contract-716). It demonstrates the granularity expected from the next graduating app.

| Photos scenario | U | C | E | Owner / evidence |
| --- | --- | --- | --- | --- |
| drawer activity, hide timer, pinned summary grains | — | ✅ | ✅ | `PhotosHome.test.tsx`; `photos-library.mjs` owns recognizer-vs-sibling hit testing |
| scrub offset → month bubble | ✅ | ✅ | — | timeline-row/model units + native responder geometry |
| empty/loading skeleton geometry | ✅ | ✅ | — | skeleton row packing + rendered progress/grid geometry |
| Select word, role, disabled state | — | ✅ | ✅ | `PhotosSelectChip` semantics; select-write journey |
| search resting/no-hits and grouped album result | ✅ | ✅ | ✅ | search grouping units; no-hits component; `photos-search.mjs` |
| viewer mode chrome and filmstrip current item | ✅ | ✅ | ✅ | viewer models; top chrome/filmstrip component; `photos-viewer.mjs` |
| Collections shelves, empty/collapsed bodies, and menu commands | ✅ | ✅ | ✅ | collection model; shelf component; Photos device entry/drill-down |
| permission-refused behavior (empty-device takeover / seeded-vault continuity) | ✅ | ✅ | ✅ | access predicate/copy proves both branches; panel component and `photos-permissions.mjs` own the empty-vault takeover on a denied device grant |
| selection trash + restore write | ✅ | — | ✅ | write batch units; `photos-select-write.mjs` |

Photos' five journeys share one paired profile and stay under eight minutes together per platform. [`photos-budget.md`](../../tests/agent-e2e-mobile/flows/photos-budget.md) owns the operational response.
