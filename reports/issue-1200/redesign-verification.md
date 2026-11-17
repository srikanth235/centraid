# Native redesign verification: #1201

## Reviewed source and build checkpoint

The local redesign uses the accepted authored light boards and generated dark/native/site outputs. Root reviewed the working docs landing, setup guide, app atlas, record/original and phone-boundary diagrams, mobile layout, dark mode, navigation, disclosures and search. Illustrations are labelled and their fictional examples are excluded from Pagefind. The final guarded docs bundle built 12 routes; `bun run docs:smoke` resolved every assembled route and fragment.

The obsolete aggregate first-run title/body are removed from Rust and both shells. Their proto numbers and names are reserved, following the existing wire contract. Guarded `xtask rules` passed all 27 rules, and the PR `buf` lane passed lint and WIRE_JSON breaking checks against main. No parity exemption or hidden consumer was added.

After that cleanup, guarded `mobile/scripts/ios-core.sh aarch64-apple-ios-sim` rebuilt the real core with the `llama` feature, and a guarded Debug arm64 simulator `xcodebuild` linked it successfully. Xcode 27.1 / iOS SDK 27.1; the review simulator runs iOS 26.5. Build logs are `/private/tmp/centraid-1201-ci-evidence/redesign-ios-core.log` and `redesign-ios-app-final.log`.

| Artifact | SHA-256 |
| --- | --- |
| `Centraid.app/Centraid` executable stub | `21537c0942627822e536b6b22365861c801351b0caeca98867d80adaed477e05` |
| `Centraid.app/Centraid.debug.dylib`, containing the current app code | `25f7b53c9a4c82e29ba1b423eb78fc7af13c88925abb3200ea12f8f53f12f630` |
| `aarch64-apple-ios-sim/debug/libcentraid_core_ffi.a`, 257,581,736 bytes | `ee2d727c7d6103ab348dcd754da2415f1c4885f3c343c349c8462424d9a83853` |

The matching simulator completed the bounded UI checkpoints below. This evidence does not claim a full largest-text pass, physical-device verification, cold notification Undo or independent native recovery. Final CI/native results remain tracked in the PR and issue.

## Historical simulator review

These results are from the local redesign checkpoint before the latest Photos accessibility-boundary fix and rebuilt app. They are historical evidence only; they do not verify the current source or final artifact.

| Mode | Result | Evidence |
| --- | --- | --- |
| Light | 1/1 route flow passed; command JSON records 95 completed, 1 skipped conditional step, 0 failed. Visited all nine app roots, Home, Chat, Backup, Settings, Notes editor, and People detail/editor. | `/private/tmp/centraid-1201-redesign-ios/output/light-review/2026-11-17_110956/commands-(iOS redesign routes).json`; screenshots in `/private/tmp/centraid-1201-redesign-ios/output/light-review/screenshots/` |
| Dark | 1/1 route flow passed; 95 completed, 1 skipped conditional step, 0 failed; same routes. | `/private/tmp/centraid-1201-redesign-ios/output/dark-review/2026-11-17_111201/commands-(iOS redesign routes).json`; screenshots in `/private/tmp/centraid-1201-redesign-ios/output/dark-review/screenshots/` |
| Largest text, first review | Failed after 7 completed commands; Photos tile visibility assertion failed, with 1 later command skipped. This is not a full route pass. The screenshot shows the top of Home at the largest accessibility size, with lower Reminders content behind the floating band. | `/private/tmp/centraid-1201-redesign-ios/output/large-text/2026-11-17_111440/commands-(iOS redesign routes).json`; screenshot `/private/tmp/centraid-1201-redesign-ios/output/large-text/2026-11-17_111440/screenshot-❌-1794894309212-(iOS redesign routes).png` |
| Largest text, route review | Failed after 48 completed commands; `health-band` assertion failed, with 1 later command skipped. The captured screen was Chat after a misdirected Home tile tap. This does not establish a Health content failure. | `/private/tmp/centraid-1201-redesign-ios/output/large-text-routes/2026-11-17_112021/commands-(iOS redesign routes).json`; screenshot `/private/tmp/centraid-1201-redesign-ios/output/large-text-routes/2026-11-17_112021/screenshot-❌-1794894707438-(iOS redesign routes).png` |

Two intervening largest-text harness runs (17 completed, 1 failed, 1 skipped each) stopped at `home-tile-photos` because their private flow omitted the scroll step. They are preserved under `/private/tmp/centraid-1201-redesign-ios/output/large-text-review/` and are not app findings. No largest-text run passed.

The pre-fix Photos frame failure is preserved in `/private/tmp/centraid-1201-redesign-ios/output/light/2026-11-17_110358/commands-(iOS redesign routes).json`: `home-tile-photos` had AX bounds `[-29,304][445,517]` on a 402 pt viewport, although its visible card was clipped to the grid. That run failed at `scrollUntilVisible` with 100% visibility. The historical light/dark route passes tapped the visible tile directly and therefore did not clear this defect.

## Verification harness notes

Private flows under `/private/tmp/centraid-1201-redesign-ios/flows/` cover all nine app roots, Home/Chat/Backup/Settings, and representative People and Notes detail/editor routes. Each Home target is centered after returning to the first tile, so either Rust tile order is supported. The dedicated `photos-frame.yaml` requires 100% visibility and centers the tile before capture. Title-focused flows assert the generic root title identifier, but screenshot and nested Text bounds review are also required because the parent may retain the same identifier while the actual title text has zero width.

## Bounded UI evidence checkpoints — 2026-11-17

These checks used the authorized iOS 26.5 review simulator and synthetic existing fixture data. Times below are local review-machine time (IST, UTC+05:30). They are checkpoint evidence, not final CI or a complete visual acceptance pass. Private Maestro artifacts are named below as plain paths; no raw diagnostic payloads or credentials are included.

### Photos frame and Home clearance — 11:40–11:49

- `photos-frame.yaml` required `visibilityPercentage: 100` and passed 8/8 commands. The compact hierarchy now reports `home-tile-photos bounds=[18,347][384,509]` on the 402 pt viewport, fully inside the viewport. Raw hierarchy and the filtered bounds line are in `/private/tmp/centraid-1201-redesign-ios/output/photos-frame-final/photos-hierarchy.csv` and `photos-bounds.txt`; screenshot and command JSON are under `output/photos-frame-final/`.
- `home-max-scroll.yaml` passed 9/9 commands. At maximum Home scroll, the final Docs widget was fully clear of the floating bottom band in `/private/tmp/centraid-1201-redesign-ios/output/home-max-scroll/screenshots/home-max-scroll-last-widget.png`. No Home inset change was supported by this evidence.

### Full route traversal — 11:43–11:54

- Light flow: 89 completed, 1 conditional skipped, 0 failed; command JSON is `/private/tmp/centraid-1201-redesign-ios/output/light-final/2026-11-17_114343/commands-(iOS redesign routes).json`.
- Dark flow: 89 completed, 1 conditional skipped, 0 failed; JUnit result is 1/1 success at 229 seconds, with command JSON `/private/tmp/centraid-1201-redesign-ios/output/dark-final/2026-11-17_115011/commands-(iOS redesign routes).json`.
- Both traversed all nine app roots, Home, Chat, Backup, Settings, and representative People and Notes detail/editor paths. Root screenshots revealed missing generic app titles; therefore these are route traversal results only, not complete visual passes. The title defect and subsequent candidate checks are below.

### Toolbar title candidates — 12:04–12:18

- Candidate 1 (dylib SHA-256 `400f30a5f5c22a63705d8bcf164d0d2578f38f271ce8521ad286830b35c74b62`) passed its 9-command identifier-only flow, but screenshot review still showed no People text. The raw compact hierarchy explains the false positive: parent `kit-header-title` bounds `[20,63][60,105]`; nested Text bounds `[60,63][60,104]` (zero width). Evidence is under `/private/tmp/centraid-1201-redesign-ios/output/title-candidate/`.
- Candidate 2 (dylib SHA-256 `faf6be82a4e9e8e8301ecd098fbffe8991e376d4b9917b991409d37a0cc9461e`) passed the focused flows at Large text. Screenshot review showed visible People and Reminders titles. Nested Text bounds were People `[60,63][171,104]` and Reminders `[60,63][233,104]`, both within the viewport. Their flow JSON and filtered bounds are under `/private/tmp/centraid-1201-redesign-ios/output/candidate-people-large/` and `candidate-reminders-large/`.
- At `accessibility-extra-extra-extra-large`, the People flow’s identifier assertion passed but the word was clipped; the nested Text bounds were `[52,37][56,130]` (4 px wide). This is a visual failure, not a pass. Evidence is in `/private/tmp/centraid-1201-redesign-ios/output/candidate-people-largest/`. Reminders-largest was not run after this defect was confirmed.
- Candidate 2’s flow commands were 10 completed, 3 conditional skipped, 0 failed per flow; the failing visual outcome is established by screenshot and nested bounds, not the Maestro status. The review simulator was restored to Light/Large and shut down after each focused lease.

No complete normal/dark/largest-text matrix, cold notification Done/receipt/Undo, physical-device check, or independent recovery check is established here. The source candidate has not yet passed its full native verification.

Since these checkpoints, `Rooms.swift` has a newer unbuilt semantic-title candidate using iOS 26's `.title` placement and explicit AppPlace reflow state. Its source diff is awaiting the serialized build and focused normal/AX5 fitting check; the screenshots above remain bound to the recorded older candidate hashes.
