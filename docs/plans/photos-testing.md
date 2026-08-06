# Photos testing contract

Issue [#716](https://github.com/srikanth235/centraid/issues/716) closes the gap between Photos' deep pure-model coverage and its native runtime. This is the durable renderer decision, mock policy, fixture contract, scenario ownership, and device-lane budget. [`TESTING.md`](../../TESTING.md#photos-scenario--layer-contract-716) remains the canonical scenario table.

## Renderer decision

Use `@testing-library/react-native` 13.3.3 on the repository's existing Vitest runner. Do not add Jest, Detox, Appium, or another runner. RNTL renders the React Native host and accessibility/responder tree, so component tests can observe `Pressable` roles and state, native responder events, accessibility labels, and rendered RN geometry that the former `react-dom`/jsdom tree could not represent.

The spike consolidated the former 23-case `PhotosHome.test.tsx` jsdom suite into eleven scenario-level RNTL cases, including a render of the real `PhotosHome`. Both measurements used a warm dependency install on the same Apple Silicon development host and ran the single file through the mobile package script:

| Renderer | Cases | Vitest duration | Test-body time | Shell wall time |
| --- | --: | --: | --: | --: |
| prior jsdom tree at PR head `8a30708d` | 23 | 1.06 s | 99 ms | 1.50 s |
| initial RNTL/Vitest spike | 9 | 3.91 s | 2.06 s | 4.32 s |
| final RNTL/Vitest contract | 11 | 4.15 s | 528 ms | 5.7 s |

The initial shell wall-time ratio was 2.88x and the Vitest-reported duration ratio was 3.69x. The latter exceeds the issue's 2–3x scrutiny threshold because it includes Babel-transforming React Native's Flow source and initializing its host renderer. That cost earns exactly one consolidated component contract file: it falsifies RN roles/states, responder wiring, and host geometry that jsdom structurally cannot. Pure models remain ordinary `*.test.ts` files, and no new component file should pay this startup cost for a claim a pure test can make. The final eleven cases average about 48 ms of test-body time and amortize the native transform/renderer startup instead of multiplying cold files.

## Mock boundary

Production JavaScript stays real through the component under test. A mock is permitted only where Node cannot provide the native implementation:

- React Native's own 0.86 preset substitutes bridge-backed host components and device services after `babel-preset-expo` transforms Flow-annotated RN source. It does not replace application components or JS helpers.
- `@react-native-async-storage/async-storage`, Expo device services, and the replica/data providers use typed factories because persistence, permissions, notifications, the gateway, and SQLite are runtime seams. The real `PhotosHome` and its visual JS children still render.
- `expo-image` and `react-native-svg` become inert host elements because their native views cannot mount in the test renderer.
- `media-source` returns the supplied URI because Expo asset resolution is a runtime boundary, not Photos behavior.
- A future component that directly reaches `op-sqlite`, FlashList native measurement, or React Native Gesture Handler must mock that module seam with an import-typed factory. It must not replace the Photos component or its JS model.

RNGH's test mock can invoke a gesture callback, but it cannot reproduce recognizer precedence against a later sibling. The shipped zoom-drawer defect was precisely that conflict: the drawer rendered yet lost the tap to the grid recognizer. `photos-library.mjs` therefore owns drawer-above-grid hit testing. The same boundary keeps pinch, pan, swipe, native modal layering, keyboard alignment, and denied OS permissions in Maestro.

## Shared deterministic fixtures

`apps/mobile/src/apps/photos/photos-fixtures.ts` is the one deterministic in-process corpus. It returns both `PhotoAsset[]` and the derived `PhotoSection[]` for `empty`, `one-day`, `multi-month`, `year-spanning`, `video-mixed`, and `place-tagged` scenarios. `timeline-model.test.ts` consumes it from the pure layer and `PhotosHome.test.tsx` consumes it from the component layer. Dates, labels, IDs, and URIs are fixed; no case depends on the clock, locale, network, or random IDs.

The device layer uses the separate but shape-aligned Photos demo seed. It creates 19 byte-bearing assets across at least three months and two years, including one video, the `Tahoe scouting` album/place, and two named people. The gateway seed test asserts those invariants through the real demo bridge rather than trusting generator literals.

## Device journeys and budget

The native runtime contract consists of exactly five independently runnable structural journeys:

1. `photos-library.mjs` — temporal headers, scrolling, drawer hit testing, and period drill-down.
2. `photos-viewer.mjs` — lightbox navigation, native menu layering, capability rows, and dismissal.
3. `photos-search.mjs` — native input, seeded album result count/group, and viewer tap-through.
4. `photos-select-write.mjs` — select two, trash, confirm, and restore through the real replica write path.
5. `photos-permissions.mjs` — denied device permission takes over a deliberately empty vault library with recovery and Home still reachable. It runs first, before the shared gateway is seeded for the remaining journeys.

`run-photos-suite.mjs` uses one gateway and one paired simulator profile while preserving one verdict per flow. The permission journey first purges the demo corpus and pairs against an empty vault; the library journey then seeds the shared gateway and normal replica sync supplies the remaining four journeys. The runner fails at eight minutes or more; the final local iOS aggregate completed in 366 seconds. [`photos-budget.md`](../../tests/agent-e2e-mobile/flows/photos-budget.md) defines the shrink/merge response if two consecutive nights breach the budget; retries and weaker assertions are not budget remedies.

Offline write/reconnect replay requires host network control and is intentionally not a sixth Photos UI journey. [#717](https://github.com/srikanth235/centraid/issues/717) owns that reliability flow.

## Closure evidence

Implementation and local evidence do not satisfy the umbrella's final operational gate by themselves. Issue #716 closes only after this decision record is merged, every scenario in the TESTING contract is closed or linked to a named follow-up, and the five-flow Photos suite is green on two consecutive nightly runs. Record those two workflow URLs on the issue before closing it.
