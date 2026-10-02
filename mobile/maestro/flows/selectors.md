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
| `home-all-apps-sheet` | Home | the all-apps sheet — **iOS only**; the Compose sheet carries no tag |
| `home-tile-<appId>` | Home | one springboard tile, keyed on the app id |
| `home-vault-switch` | Home | the vault lockup, which IS the switch |
| `home-settings` | Home | the title row's one control |
| `home-band` | Home | the floating band plate |
| `home-band-<placeId>` | Home | one band destination (`home`, `notifs`, `stats`, `data`) |
| `home-band-more` | Home | the band's More tab |
| `home-band-chat` | Home | the band's Chat tab (the second place, after Home) |
| `home-backup-nudge` | Home | the "no backup yet" line (and `-action`, `-dismiss`) |
| `home-sample-notice` | Home | the sample vault's one notice line (R-SAMPLE-8) |
| `home-sample-remove` | Home | the notice's outlined "Remove sample" |
| `sample-remove-confirm` | Home, Settings | the destructive "Remove" in the removal's confirm alert |
| `home-vault-sheet` | Home | the vault switcher sheet |
| `vault-row-<vaultId>` | Home | one switcher row (and `vault-forget-<vaultId>`) |
| `vault-sample-mark` | Home | the "Sample" chip on a switcher row, shown only when the vault was renamed |
| `vault-found-button` | Settings | "Make a vault on this phone" |
| `vault-restore-button` | Settings | "Restore my vaults" |
| `vault-sample-remove` | Settings | "Remove sample", while a sample is held |
| `vault-sample-add` | Settings | "Add sample", while none is held |
| `vault-sample-adding` | Settings | the disabled "Adding sample" while it seeds |
| `vault-done` | Settings | the sheet's Done |
| `first-launch` | First launch | the deck (and `first-launch-skip`, `first-launch-<id>` for its actions) |
| `chat` | Chat | the tab's root |
| `chat-field` | Chat | the composer's text field (ready phase only) |
| `chat-send` | Chat | Send, which becomes `chat-stop` while a turn runs |
| `chat-stop` | Chat | Stop, while a turn runs |
| `chat-download` | Chat | "Download model", in the model step |
| `chat-model-note` | Chat | the model step's one sentence |
| `chat-empty` | Chat | the empty thread's one line |
| `chat-suggestion-<n>` | Chat | the n-th suggested question, from 0 |
| `chat-card-<n>` | Chat | the n-th row-card under an answer, from 0 |
| `chat-new` | Chat | the header's New chat |

Home, its Settings and vault sheets, the first-launch deck and Chat set tags. The iOS shell runs on a simulator against the real `HomeMachine` through `HomeBridge`, so the iOS half of each id renders; the Android half is compiled and unobserved, because no machine here has an Android emulator.

**STILL UNPROVEN: "each id selects exactly one thing".** No Maestro flow has executed; `home.yaml` is the first run that would prove it. Until then, `home.yaml`'s `home-all-apps-sheet` assertion can only pass on iOS.
