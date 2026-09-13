# Selectors, per screen

One string per control, set with `Modifier.testTag` in Compose and `.accessibilityIdentifier` in SwiftUI — **the same string on both**, which is what lets one flow file drive two platforms.

| Id | Screen | What renders it |
| --- | --- | --- |
| `home-grid` | Home | the springboard grid |
| `home-status` | Home | the health ribbon |
| `home-day-one` | Home | the first-run page |
| `home-first-moves` | Home | the first-moves band |
| `home-failure` | Home | the failed-read sentence (no grid) |
| `home-all-apps` | Home | the all-apps control |
| `home-all-apps-sheet` | Home | the all-apps sheet |
| `home-tile-<appId>` | Home | one springboard tile, keyed on the app id |
| `home-vault-switch` | Home | the vault lockup, which IS the switch |
| `home-settings` | Home | the title row's one control |
| `home-band` | Home | the floating band plate |
| `home-band-<placeId>` | Home | one band destination (`home`, `notifs`, `stats`, `data`) |
| `home-band-more` | Home | the band's More tab |
| `tally-band-activity` | Tally list | the Activity band button |
| `tally-band-balances` | Tally list | the Balances band button |
| `tally-refresh` | Tally list | the icon-only refresh control |
| `tally-rows` | Tally list | the row list |
| `tally-empty` | Tally list | the "Nothing here yet." sentence |
| `tally-failure` | Tally list | the failure sentence |
| `tally-withheld` | Tally list | the withheld-verb sentence |
| `photos-band-library` | Photos grid | the Library band button |
| `photos-more-sheet` | Photos grid | the icon-only `more` control |
| `photos-grid` | Photos grid | the cell grid |
| `photos-backup-banner` | Photos grid | the backup phase sentence |
| `photos-allow-access` | Photos grid | the permission button (NOT_ASKED only) |
| `notes-title` | Notes editor | the title field |
| `notes-body` | Notes editor | the body field |
| `notes-save` | Notes editor | the save button |
| `notes-save-state` | Notes editor | the save line |
| `notes-pin` | Notes editor | the icon-only pin control |

**HOME'S TAGS ARE SET AND HOME HAS RUN; THE OTHER SEVENTEEN ARE NOT SET.**
Home's are set in both shells because wave A built that screen and compiled both
halves, and the iOS shell now runs on a simulator against the real `HomeMachine`
through `HomeBridge` — the lockup, the title row, the status ribbon, the graded
grid and the band all render from one state message.

**STILL UNPROVEN: "each id selects exactly one thing".** No Maestro flow has
executed. `mobile/maestro/flows/home.yaml` is written and unrun, because the
machines that run `cargo xtask gate` have neither a simulator nor an emulator,
and this one has no Android emulator installed (no `emulator` package and no
system image under `$ANDROID_HOME`). The Android half of every id above is
therefore compiled and unobserved. The original note, which still governs the
other seventeen, follows.

**THE TAGS ARE NOT SET YET.** The Compose and SwiftUI sources in `mobile/androidApp` and `mobile/iosApp` render these controls and carry their accessibility labels, but not their test tags: a tag is only useful to a flow that can run, and adding seventeen of them on a machine that cannot run one would be seventeen strings nothing checks. The owner hand-off in `mobile/README.md` pairs "add the tags" with "run the flows", in that order, so the first run is what proves each id selects exactly one thing.
