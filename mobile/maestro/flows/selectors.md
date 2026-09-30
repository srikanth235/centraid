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

Home is the only screen that sets tags. The iOS shell runs on a simulator against the real `HomeMachine` through `HomeBridge`, so the iOS half of each id renders; the Android half is compiled and unobserved, because no machine here has an Android emulator.

**STILL UNPROVEN: "each id selects exactly one thing".** No Maestro flow has executed; `home.yaml` is the first run that would prove it. Until then, `home.yaml`'s `home-all-apps-sheet` assertion can only pass on iOS.
