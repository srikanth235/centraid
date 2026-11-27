# App-plane remediation evidence

This review accompanies PR #1215 and issue #1214. M1, M3 and M4 require the owner's review and remain unticked.

- [Schema review](schema-review.md): all 67 A–L items at the immutable schema evidence pin, deviations, exact tests, A1–A18 commit provenance, and the SQL diff against main.
- [People review](people-review.md): P1–P10 behavior, screenshots, tests, and evidence limits.
- [Money review](money-review.md): P1–P10 plus Statement says, reimport, splits, transfers, match proposals, recurring observations, currency correction, and ambiguous dates.
- [Validation](validation.md): commands, results, and layers still owed.
- [iOS handoff](ios-handoff.md): exact Mac build, test, and capture instructions.
- [Room fixture manifest](room-fixtures.json): provenance for the 20 real Core Room fixtures rendered as 40 Android Compose/Robolectric previews.

## Availability and scope

Phone effects, followed-store readers, guarded Locker sessions, shared actions and bulk Undo, FTS search, civil time forms, imports/exports, Money observations, and the Health typical range are implemented. The test receipts establish the exercised Rust and Android paths; they do not replace device checks.

Locker secret replacements use editable, masked controls with password keyboards. Typed values remain in zeroizing room state and are not echoed into the outgoing Room. Kind changes reset the field; long values use the existing value budgets, and oversized saves are refused rather than silently shortened. Editing an item invalidates earlier revealed values before its detail page is shown again.

Chat Send remains disabled with an unavailable explanation. Photos Free up space and unsupported sharing are absent from the room menu. Locker Export is absent from the room menu. Photo place naming remains (target). Saving an edited photo accepts an image the member has already edited and stores a new photo linked to its source; an in-app image transformation editor is not claimed.

Android has no native Reminders store. Its UI does not offer following that store. Native owner authentication, clipboard expiry, OS pickers/share/save sheets, followed-store permissions, and background transitions still need physical-device exercise. iOS SDK compilation, XCTest, simulator screenshots, and an iOS device build have not run on the Linux implementation host.

Calendar readers fetch bounded windows. iOS represents the queried occurrences individually and marks the pass incomplete rather than inventing a recurrence rule. These passes do not establish deletion outside their queried window.

Two findings needed no new behavior: Notes bodies are local text rather than fetchable document originals; a failed note read does not produce an editable blank body. File byte quantities deliberately ignore the metric/imperial switch in the shared quantity formatter, so the same byte size is shown under either preference.

## Android glass appearance

The floating controls now use a softer shadow and a subtle rim. Haze 1.6.10 samples the scrolling content behind the plate on Android 12/API 31 and later; Android 7–11 keeps a translucent tint. High contrast and secure rooms use an opaque surface. The source is scoped to each ordinary room, excludes its controls, and is disabled for secure content. Footer clearance lets the last row scroll fully into view. This approximates the iOS material appearance; it does not implement Apple's Liquid Glass refraction or morphing.

The [light preview](snapshots/light/money_root.png), [dark preview](snapshots/dark/money_root.png), and [earlier shadow](snapshots/before/light/money_root.png) are actual Compose/Robolectric captures. GPU blur and scrolling performance still require a phone check.

The separate [scrolling light](snapshots/glass-scroll/light/money_glass_scroll.png) and [scrolling dark](snapshots/glass-scroll/dark/money_glass_scroll.png) captures use a [Core-generated 40-transaction fixture](glass-layout-fixture.json). The layout test verifies that content extends behind the footer and that the final row can scroll fully above it. These two images are additional to the 40 People/Money review previews.

Assistant data regeneration, the world/seeder/act-plan rebuild, dataset drift/pinning, and paid model calls were excluded by the owner. The stale data-pin finding is retained. CI/full gate profiles, release-lane repair, restore drills, and rewriting unsigned historical merges are outside this remediation pass.
