# App-plane remediation evidence

This review accompanies PR #1215 and issue #1214. M1, M3 and M4 require the owner's review and remain unticked.

- [Schema review](schema-review.md): all 67 A–L items at the immutable schema evidence pin, deviations, exact tests, A1–A18 commit provenance, and the SQL diff against main.
- [People review](people-review.md): P1–P10 behavior, screenshots, tests, and evidence limits.
- [Money review](money-review.md): P1–P10 plus Statement says, reimport, splits, transfers, match proposals, recurring observations, currency correction, and ambiguous dates.
- [Validation](validation.md): commands, results, and layers still owed.
- [iOS handoff](ios-handoff.md): exact Mac build, test, and capture instructions.
- [Room fixture manifest](room-fixtures.json): provenance for the 20 real Core Room fixtures rendered as 40 Android Compose/Robolectric previews.
- [Android preview manifest](snapshots/android-manifest.json): 42 refreshed light/dark preview captures, including 40 Room reviews and two scrolling layouts, rendered from source `be6c4d0`.

## Availability and scope

Phone effects, followed-store readers, guarded Locker sessions, shared actions and bulk Undo, FTS search, civil time forms, imports/exports, Money observations, and the Health typical range are implemented. The test receipts establish the exercised Rust and Android paths; they do not replace device checks.

Locker secret replacements use editable, masked controls with password keyboards. Typed values remain in zeroizing room state and are not echoed into the outgoing Room. Kind changes reset the field; long values use the existing value budgets, and oversized saves are refused rather than silently shortened. Editing an item invalidates earlier revealed values before its detail page is shown again.

Chat Send remains disabled with an unavailable explanation. Photos Free up space and unsupported sharing are absent from the room menu. Locker Export is absent from the room menu. Photo place naming remains (target). Saving an edited photo accepts an image the member has already edited and stores a new photo linked to its source; an in-app image transformation editor is not claimed.

Android has no native Reminders store. Its UI does not offer following that store. Native owner authentication, clipboard expiry, OS pickers/share/save sheets, followed-store permissions, and background transitions still need physical-device exercise. Hosted iOS run [46071464163](https://github.com/srikanth235/centraid/actions/runs/46071464163) at 096 passed 174 unit tests, had 55 UI failures, and passed the unsigned build. Run [46084049333](https://github.com/srikanth235/centraid/actions/runs/46084049333) at be6 passed 175 unit tests and the unsigned build; UI had 53 failures, Reduce Motion had 26, so the overall job failed. All three focus-order tests passed. Ten required screenshots and two XXXL repair originals were verified, reviewed and copied with provenance; no physical-device behavior is established. See [iOS snapshots](snapshots/ios/provenance.json), [run receipts](validation/ios-unit.txt), and [attempt history](validation/ios-runner-attempts.txt).

A Photos change lets both native grids/viewers resolve opaque photo owner refs through existing Core `ContentUrls`; Rust emits `photo.id`, with no schema or wire change. It accepts only an existing embeddable Store image path. OS-library-only previews remain placeholders, and the demo world's text data mislabeled as JPEG was left untouched under the data exclusion. Android Kotlin compilation and five Robolectric resolver tests passed; focused Rust integration, format and Clippy passed. The API 24 arm64 APK has now been rebuilt from source `be6c4d0` with matching Core and verified exports, dependencies, alignment and signer. The refreshed Android preview set includes the reimported Money screen with +500 green and -500 black; all 42 captures and hashes are recorded in the [Android preview manifest](snapshots/android-manifest.json). These are Compose/Robolectric previews, not phone screenshots. No physical-device run is claimed. See the [Photos resolver receipt](validation/android-photo-content.txt), [Net tone receipt](validation/android-net-tone.txt), and [APK artifact receipt](validation/android-artifact.json).

Calendar readers fetch bounded windows. iOS represents the queried occurrences individually and marks the pass incomplete rather than inventing a recurrence rule. These passes do not establish deletion outside their queried window.

Two findings needed no new behavior: Notes bodies are local text rather than fetchable document originals; a failed note read does not produce an editable blank body. File byte quantities deliberately ignore the metric/imperial switch in the shared quantity formatter, so the same byte size is shown under either preference.

## Android glass appearance

The floating controls now use a softer shadow and a subtle rim. Haze 1.6.10 samples the scrolling content behind the plate on Android 12/API 31 and later; Android 7–11 keeps a translucent tint. A contrast-preserving scrim keeps selected and inactive text legible over extreme photo backgrounds; both color schemes are tested at a minimum 4.5:1. High contrast and secure rooms use an opaque surface. The source is scoped to each ordinary room, excludes its controls, and is disabled for secure content. Footer clearance lets the last row scroll fully into view. This approximates the iOS material appearance; it does not implement Apple's Liquid Glass refraction or morphing.

The [light preview](snapshots/light/money_root.png), [dark preview](snapshots/dark/money_root.png), and [earlier shadow](snapshots/before/light/money_root.png) are actual Compose/Robolectric captures. GPU blur and scrolling performance still require a phone check.

The separate [scrolling light](snapshots/glass-scroll/light/money_glass_scroll.png) and [scrolling dark](snapshots/glass-scroll/dark/money_glass_scroll.png) captures use a [Core-generated 40-transaction fixture](glass-layout-fixture.json). The layout test verifies that content extends behind the footer and that the final row can scroll fully above it. These two images are additional to the 40 People/Money review previews.

Assistant data regeneration, the world/seeder/act-plan rebuild, dataset drift/pinning, and paid model calls were excluded by the owner. The stale data-pin finding is retained. Broader CI/full gate-profile repair, release-lane repair, restore drills, and rewriting unsigned historical merges are outside this remediation pass. The requested hosted iOS simulator and unsigned-device verification completed in run `46084049333`; the test outcomes and remaining failures are recorded in [validation](validation/ios-unit.txt).
