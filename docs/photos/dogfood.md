# Photos dogfood ritual (D2)

The discovery and regression-detection pattern for the Photos application, and when it should run in the release cycle.

## Why dogfood matters

Centraid ships no telemetry — no event logging, no crash reporting service, no aggregate usage heuristics; local logs ([logs](../logs.md)) never upload. A maintainer importing their real camera roll and living in it side-by-side with native iOS Photos is therefore the **only discovery channel** for Photos defects. This is not a nice-to-have ritual; it is the quality gate.

The pattern is a written checklist so that every maintainer and release lead follows the same motion and catches the same class of bugs. Findings live in `QUALITY.md` under `## Open` (per [AGENTS.md](../../AGENTS.md) convention).

## The ritual (checklist)

Run this motion:

1. **Put a real library on the phone.** Use your own camera roll, not a test fixture: 528+ photos, spanning several years, mixed origins (camera, screenshot, screen recording, panorama, duplicate captures), and at least one year before 2020 (your test set for the grain control's year). This tree has no Takeout importer ([switcher walkthrough](switcher-walkthrough.md), step 1), so the camera roll is how a real library arrives.

2. **Let the camera roll back up.** Grant photo access; the backup runs on its own and there is no import offer to accept ([R-1029-PH-4](../decisions.md#photos-what-the-port-builds-and-what-it-does-not-1029)). Verify:
   - [ ] The library fills as the pass runs: skeleton tiles give way to photographs with no "waiting" stall.
   - [ ] A partial grant says so and offers its remedy (the limited-library picker on iOS, "Select more photos" on Android); a denied one offers Open Settings.
   - [ ] Killing the app mid-pass and reopening resumes where it stopped, and no photograph appears twice.
   - [ ] Spot-check the vault's photograph count against the camera roll afterward.

3. **Compare the phone against native Photos app.** Run the simulator and native Photos side-by-side. Open the same 2019 photograph in both and verify:
   - [ ] Photo appears in both, under the same calendar day (capture-local, not UTC).
   - [ ] Orientation and location match what the camera roll carried.
   - [ ] The grain control (Years / Months / All) is discoverable without being told where it is — this exact control was once a scroll-armed drawer nobody found.

4. **Search for something by year.** Use the timeline's year selector and verify:
   - [ ] Selecting "2019" shows only photos from that year; no stale results.
   - [ ] Scrolling the filtered timeline is smooth (no 10k-row hang).
   - [ ] Returning to "All years" restores the full library without re-syncing.

5. **Search.** Verify:
   - [ ] A caption word finds the photograph, offline too — the vault is on the phone.
   - [ ] A person, place or album a query names stands above the grid as a top hit and opens its shelf; before a query, the resting page lists the vault's own people, places, albums and labels.

6. **Send a copy.** Photos has no sharing with another person ([R-1029-PH-3](../decisions.md#photos-what-the-port-builds-and-what-it-does-not-1029)); what leaves is a copy. Verify:
   - [ ] Send a copy from the viewer, from a shelf's selection and from the library's opens the system share sheet.
   - [ ] With the location left out, the file that arrives carries no GPS — check its EXIF on the receiving end, not the sentence on the phone.
   - [ ] Download puts the original in this device's own photo library.

7. **Keep originals, and the free-up-space census.** Verify:
   - [ ] An album's "Keep originals on this phone" switch shows the flip at once, settles, and is still set after a relaunch.
   - [ ] The More sheet counts the originals on this phone, their size and the kept share, and says why none can be freed — there is no release button ([R-1029-PH-1](../decisions.md#photos-kept-originals-and-freeing-space-1029)).
   - [ ] The Backup row reports this device's own pass.

8. **Set an album's key photo.** Verify:
   - [ ] In an album, selecting one photograph offers Make key photo; the viewer's `···` offers it only when the photograph was opened from an album.
   - [ ] The chosen cover appears on the album in the Add to album sheet. Collections' album tiles draw no cover, which is expected ([switcher walkthrough](switcher-walkthrough.md), step 9).

9. **People, faces and memories.** Nothing in this tree detects faces or runs OCR ([switcher walkthrough](switcher-walkthrough.md), steps 6 and 11), so a library brought in from the camera roll has an empty review queue; run these on a vault that holds face rows. Verify:
   - [ ] Skip moves a face to the back of the queue and writes nothing; "Keep unnamed" dismisses it; New person names one in a single step and the confirm follows.
   - [ ] A confirmed person's photographs are browsable from their card.
   - [ ] Forget a person (`media.forget_person`) and verify their regions leave the review queue and no photo still shows their name.
   - [ ] An empty Memories shelf reads that Centraid has not looked yet, never that there are none; a trip memory draws its route from the member's own coordinates.

10. **Check four known stuck-state classes**:

- [ ] **Stuck backup indicator:** a backup-in-progress line that never clears. A hung camera-roll pass or an unreachable laptop makes this visible; `docs/logs.md` → the mobile logs should show steady progress or a clear offline sentence, never a silent hang.
- [ ] **Quadruple offline announcements:** the offline line appeared four times in one session. If it repeats, the banner logic has drifted.
- [ ] **Undiscoverable grain control:** Years / Months / All must stay inside the safe area in portrait and never scroll away with the grid.
- [ ] **Cold start hangs on a populated vault:** with the laptop unreachable, the library must open from the vault on the phone and never wait on the network.

## Cadence and filing

Run this ritual **before each release prep** — issue #721 is the umbrella, but every subsequent release should repeat the motion. A faster, in-the-flow variant during development: open one recent photo you took, search for one word from its caption, and verify no hang. That is not a substitute for the full checklist; it is a smoke test.

File findings in `QUALITY.md` under `## Open` with the motion that found it and the observed behavior. Example:

```markdown
## Open

- Photos: backup line stuck after a camera-roll pass, cleared after app restart ([motion 2](#)). Mobile logs show the last photograph staged and no end of pass. Query to investigate: the camera-roll runner's cursor write.
```

Move findings to `## Resolved` when:

- A fix lands in main.
- The behavior is reproduced and confirmed as expected (not actually broken).
- The issue is documented as deferred (e.g., "Collections' album tiles draw no cover", recorded in the switcher walkthrough).

Related: [QUALITY.md](../../QUALITY.md), [logs](../logs.md).
