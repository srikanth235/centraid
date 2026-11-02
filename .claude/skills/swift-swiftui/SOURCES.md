# Sources

Every copied file was reformatted by oxfmt and had its links adapted: a link to a pack file that was not copied became plain text, and the pack's `references/` prefix on sibling file names was dropped. Nothing else in a copied file was changed. No script, hook, plugin manifest, agent yaml, MCP config or asset was copied. Licence texts are in [licenses/](licenses/).

| Pack | URL | Commit | Licence | Files copied |
| --- | --- | --- | --- | --- |
| SwiftUI Expert Skill | https://github.com/AvdLee/SwiftUI-Agent-Skill | `204dba7c67256a8b707ee3fbc5759a824191974f` | MIT, Antoine van der Lee ([licence](licenses/AvdLee-SwiftUI-Agent-Skill-LICENSE)) | 20, into `references/swiftui/` |
| SwiftUI Pro | https://github.com/twostraws/SwiftUI-Agent-Skill | `f2920b63995263f57b3e198674e89a602efba6d2` | MIT, Paul Hudson ([licence](licenses/twostraws-SwiftUI-Agent-Skill-LICENSE)) | 10, into `references/swiftui-pro/` |
| Swift Concurrency | https://github.com/AvdLee/Swift-Concurrency-Agent-Skill | `d5770817d2622e1585b1f7eaebc791a9cb0959c8` | MIT, Antoine van der Lee ([licence](licenses/AvdLee-Swift-Concurrency-Agent-Skill-LICENSE)) | 12, into `references/concurrency/` |
| Swift Testing Expert | https://github.com/AvdLee/Swift-Testing-Agent-Skill | `798e9b1a2bcac164d4f0c781908199e754f0bab6` | MIT, Antoine van der Lee ([licence](licenses/AvdLee-Swift-Testing-Agent-Skill-LICENSE)) | 9, into `references/testing/` |
| Bama `swift-swiftui` | https://github.com/daveebbelaar/bama | `639893c397278256f1ae204dd8f837eb82bd6527` | MIT ([licence](licenses/Bama-LICENSE)) | 0 files; the shape of `SKILL.md` and several rows adapted (the runtime trap, the reserved type names, parts of the two error tables) |

## Left out, and why

- **SwiftUI Expert Skill.** `SKILL.md` (a router and trace-recording workflow written around scripts that are not copied); `liquid-glass.md` (R2); `macos-scenes.md`, `macos-views.md`, `macos-window-styling.md`, `document-apps.md`, `iphone-duo.md` (platforms and APIs this iOS 17.5 shell does not target); `charts.md`, `charts-accessibility.md`, `webkit-integration.md`, `styled-text-editing.md` (no Charts, WebKit view or rich text editor in `Sources/`); `localization.md` (copy is Rust's); `trace-analysis.md`, `trace-recording.md` (drive scripts); `scripts/`, `agents/`, `assets/`.
- **SwiftUI Pro.** `SKILL.md`; `design.md` (conflicts with the token rules, [CENTRAID.md](CENTRAID.md)); `localization.md`; `agents/`, `assets/`.
- **Swift Concurrency.** `SKILL.md` (its diagnostics table informed the one in our `SKILL.md`); `_index.md`; `async-algorithms.md` (needs a package the repo does not use); `core-data.md` (no Core Data); `linting.md` (no SwiftLint); `agents/`, `assets/`, plugin manifests.
- **Swift Testing Expert.** `SKILL.md`; `_index.md`; plugin manifests.
- **Not used at all:** `dpearson2699/swift-ios-skills`, whose licence (PolyForm) does not allow copying.

References in the copied files to a file listed above are left as plain text. They name material that is not here; do not look for it.

## Written here

`SKILL.md`, `CENTRAID.md`, this file, `references/xctest-in-this-repo.md` and `references/observable-migration.md`.
