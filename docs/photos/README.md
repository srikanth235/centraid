# Photos documentation

This directory is the current-state register for the Photos application. Each file serves a different reader moment, so the directory is clustered rather than merged into one long document.

| Document | Current contract |
| --- | --- |
| [Derived ledger](derived-ledger.md) | Model-derived rows, provenance, consent, sqlite-vec loading, Memories, and face deletion |
| [Places](places.md) | Member-named locations, one shared projection, geometry, and the no-basemap boundary |
| [Dogfood](dogfood.md) | The real-library discovery ritual, release cadence, and known regression classes |
| [Switcher walkthrough](switcher-walkthrough.md) | The day-one Google Photos refugee journey and the shipped/partial boundaries it exercises |
| [Design notes](../design-divergences.md#photos--sanctioned-design-divergences) | Sanctioned copy, control, colour-role, and metric-perfect divergences (shared register) |

## The phone viewer's layout

The phone viewer is **image first**: the pager is an absolute layer running the full window, so a photograph is aspect-fitted and centred in the whole viewport (a square one is 402pt tall on a 402×874 screen) and every control floats on top of it — three plates at the head (back · capture stamp · more), the pager chevrons at the sides, and one foot overlay carrying the status plate, the 58pt filmstrip and the chip · capsule · chip action row, with the write refusal on its own plate under the row — one ladder (`viewerWriteRefusal`, shared with the `···` menu and the lightbox's `writeReason`): a read-only grant says the vault is read-only, and a photograph the seat has no vault row for yet says it is not in a vault yet rather than blaming the vault. Nothing is stacked in a flex column with the photograph any more: the filmstrip's `ScrollView` carries a `flexGrow: 1` of its own that a `height` does not cancel, and in the old column it absorbed half the free height into a band of black while the photograph shrank to a 313pt letterbox ([#1011](https://github.com/srikanth235/centraid/issues/1011)). A **single tap on the photograph puts the chrome away and another brings it back**; the viewer opens with it drawn, any navigation re-draws it, and it never hides while a screen reader is running or while the editor or the slideshow is the mode. There is no standing gesture-teaching sentence — the status line draws only when it has something true to say (a zoom readout, an offer to fetch the original, what a video is playing), and the gestures keep their pointer equivalents on the stage rather than a label.

The files describe current behaviour, deliberate absences, and the issue that settled each non-obvious boundary. Historical implementation sequences belong in the linked issues and receipts.

Related current-state registers: [design divergences](../design-divergences.md), [blueprint seats](../blueprint-seats.md), [recognition automations](../recognition-automations.md), and [design machinery](../design-machinery.md).
