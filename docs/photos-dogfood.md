# Photos dogfood ritual (D2)

Settled **2026-08-07** (issue #721). The discovery and regression-detection pattern for the Photos application, and when it should run in the release cycle.

## Why dogfood matters

Centraid ships no telemetry — no event logging, no crash reporting service, no aggregate usage heuristics. A maintainer importing their real camera roll and living in it side-by-side with native iOS Photos is therefore the **only discovery channel** for Photos defects. This is not a nice-to-have ritual; it is the quality gate.

The pattern is a written checklist so that every maintainer and release lead follows the same motion and catches the same class of bugs. Findings live in `QUALITY.md` under `## Open` (per [AGENTS.md](../AGENTS.md) convention).

## The ritual (checklist)

Run this motion:

1. **Export a real Takeout.** Use your personal Google Takeout, not a test fixture. 528+ photos, spanning several years, mixed device origins (phone, camera, screenshot, screen recording, panorama, duplicate captures). Include at least one year prior to 2020 (your test set for the year-selector in grain control).

2. **Import into a staging vault.** Use the import flow: staged draft → review → publish. Verify:
   - [ ] Staged import appears, shows photo count and date range.
   - [ ] Review screen renders thumbnails without blocking (no hung grid).
   - [ ] Publish completes without crashes or orphaned rows (spot-check vault row count afterward).
   - [ ] Imported photos appear in the timeline immediately after publish; no "waiting for sync" stall.

3. **Compare the phone against native Photos app.** Run the simulator and native Photos side-by-side. Open the same 2019 photograph in both and verify:
   - [ ] Photo appears in both, under the same calendar day (capture-local, not UTC).
   - [ ] EXIF rotation and location match what the export carried.
   - [ ] The grain control (Years / Months / All) is discoverable without being told where it is — this exact control was once a scroll-armed drawer nobody found.

4. **Search for something by year.** Use the timeline's year selector and verify:
   - [ ] Selecting "2019" shows only photos from that year; no stale results.
   - [ ] Scrolling the filtered timeline is smooth (no 10k-row hang).
   - [ ] Returning to "All years" restores the full library without re-syncing.

5. **Search.** Verify:
   - [ ] A caption word finds the photograph (device-local FTS; works offline).
   - [ ] Person / place / album hits appear as grouped rows with counts.
   - [ ] With an embedder configured on the gateway, a content query ("beach sunset") produces the semantic hit group; without one, the group is simply absent and nothing else about search breaks.

6. **Share one photo.** Verify:
   - [ ] Share targets include Household members and audience vaults.
   - [ ] After placement, the photo appears in the recipient's vault with proper custody markers.

7. **Free up space (custody workflow).** Verify:
   - [ ] Offload flow shows device-only photos distinctly.
   - [ ] After offload, custody state changes; reappears when device comes back online.
   - [ ] Desktop can offload/recall; phone can offload but marks remote-only locally.

8. **Set a key photo on a Collection.** Verify:
   - [ ] Selection UI is clear (the photo is highlighted; a previous selection is deselected).
   - [ ] Key photo appears on the Collection tile.
   - [ ] Offline, the cached key photo still renders.

9. **Recognition automations.** Install the optional local model runtime and weights (`bun run --cwd tools/recognition-automations setup`), then run the gateway normally. Verify:
   - [ ] OCR an image of a receipt or sign, then search for a word from it — the text hit appears once the OCR automation has run.
   - [ ] OCR a PDF with embedded text and a scanned PDF; both become searchable, with rendered-page OCR used only where a text layer is absent.
   - [ ] Missing assets or an OCR model error produces a visible failed automation turn rather than a stuck spinner.
   - [ ] Consent-scan faces from the People shelf's empty-state gate (or "Detect faces"); verify the review queue fills with proposed regions on your own library.
   - [ ] Name an unnamed cluster and confirm a proposal onto a known person; verify the person's photos are browsable from their card.
   - [ ] Forget a person (`media.forget_person`) and verify their regions disappear from the review queue and no photo still shows their name.
   - [ ] Check the Memories shelves (on-this-day, trip, similar) render with real dates and groupings, and show nothing rather than a wrong grouping when your library has none for a kind.

10. **Check for four specific stuck states** (from prior regressions):

- [ ] **Stuck sync bar:** a sync-in-progress indicator that never clears. Check mobile background sync — a hung upload queue or unreachable-gateway loop makes this visible. `docs/logs.md` → gateway and mobile logs should show steady progress or a clear "offline" message, never silent hangs.
- [ ] **Quadruple offline announcements:** the offline banner appeared four times in one session. Check system notifications; background push should deliver once, not repeated. Mobile's `kit/replica/mount-plan.ts` prevents waiting for the network before opening local data — if the offline line repeats, the banner logic has drifted.
- [ ] **Undiscoverable grain control:** the slider exists but scrolls past the bottom of the screen. Check mobile portrait orientation; the Media Viewer must keep the slider in the safe area. Desktop may scroll; phone must not.
- [ ] **Cold start hangs on 528-row local DB:** on a launch with no reachable gateway, the timeline never opens even though 528 rows are on the device. This was the mount-plan regression; the fix was phase A disk-only planning. If this recurs, the replica mount is waiting on the network again.

## Cadence and filing

Run this ritual **before each release prep** — issue #721 is the umbrella, but every subsequent release should repeat the motion. A faster, in-the-flow variant during development: open one recent photo you took, search for one word from its caption, and verify no hang. That is not a substitute for the full checklist; it is a smoke test.

File findings in `QUALITY.md` under `## Open` with the motion that found it and the observed behavior. Example:

```markdown
## Open

- Photos: sync bar stuck after offload on mobile, resumed after app restart ([motion 7](#)). Gateway logs show successful write; mobile logs show hang after ACK. Query to investigate: background sync queue reconciliation.
```

Move findings to `## Resolved` when:

- A fix lands in main.
- The behavior is reproduced and confirmed as expected (not actually broken).
- The issue is documented as deferred (e.g., "grain control scrolls on desktop by design").

Related: [QUALITY.md](../QUALITY.md), [logs.md](logs.md).
