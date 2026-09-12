# Selectors, per screen

One string per control, set with `Modifier.testTag` in Compose and `.accessibilityIdentifier` in SwiftUI — **the same string on both**, which is what lets one flow file drive two platforms.

| Id | Screen | What renders it |
| --- | --- | --- |
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

**THE TAGS ARE NOT SET YET.** The Compose and SwiftUI sources in `mobile/androidApp` and `mobile/iosApp` render these controls and carry their accessibility labels, but not their test tags: a tag is only useful to a flow that can run, and adding seventeen of them on a machine that cannot run one would be seventeen strings nothing checks. The owner hand-off in `mobile/README.md` pairs "add the tags" with "run the flows", in that order, so the first run is what proves each id selects exactly one thing.
