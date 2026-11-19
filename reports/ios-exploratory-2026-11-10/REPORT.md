# iOS exploratory audit — 10 November 2026

Status: completed exploratory pass. **21 confirmed findings**, including one P1 recovery-guidance issue. All nine mini apps were exercised individually, followed by shared Chat, Backup, Settings and global search. This is a bounded manual audit, not a claim that every possible state is defect-free.

## Environment and method

- Commit: `d8daadc46` (clean working tree before this audit).
- Freshly built Rust simulator archive with `llama`; regenerated Xcode project; successful Debug iOS app build.
- iPhone 17 Pro (`c1173-review`), iOS 26.5, Xcode 27.1 installed on this Mac. Repository CI pins Xcode 26.3; this is a local exploratory run, not pinned-CI evidence.
- Existing **Demo vault**, never a live vault. New records use `QA` names. Reversible edits/deletes and restore are exercised; no permanent purge or outbound communication.
- Manual user interaction through Device Hub, inspecting screenshots and accessibility state. Screenshots and text observations are in `evidence/`.
- Expected behavior comes from `.claude/skills/product-intuition/` and the visible UI contract.
- Simulator responsiveness observations do not prove physical-device performance. No duration-based gate or test is introduced.
- Baseline light appearance plus dark appearance were inspected. Simulator text size was increased twice through Device → Accessibility for a larger-text pass, then decreased twice to restore the baseline. Centraid's appearance preference was restored from Dark to its original System setting. The exact Dynamic Type category was not recorded; this was not the maximum accessibility-size matrix.

## Confirmed findings

### QA-01 — Reminders’ More sheet is titled “Calendars” (P2, navigation/copy)

Steps: Home → Reminders → More.

Actual: the sheet heading is **Calendars**, over Anytime, Logbook, Reminders, Trash, Import reminders and What Reminders may read.

Expected: a heading identifying Reminders’ secondary destinations, without naming the separate Calendar app.

Evidence: [screenshot](evidence/reminders-more-wrong-title.png), [accessibility state](evidence/reminders-more-wrong-title.txt).

### QA-02 — Calendar and Reminders search promise the wrong scope (P3, copy/accessibility)

Steps: open Calendar → Search; search `dentist`. Open Reminders and inspect its search key.

Actual: Calendar’s search placeholder and both apps’ search keys say **Search events and tasks**. Calendar returns the event “Dentist — cleaning”, while the existing task “Book dentist appointment” is correctly excluded.

Expected: Calendar says it searches events; Reminders says it searches reminders/tasks, matching the intentionally split apps.

Evidence: [Calendar screenshot](evidence/calendar-search.png). The placeholder is visible in the manual interaction history before entering the query; the keys were observed in accessibility state.

### QA-03 — Today repeats its task count on a separate line (P3, visual)

Steps: Reminders → Today.

Actual: `Tuesday 10 November · 9 to do` is immediately followed by another line `9 tasks`, before the Overdue section.

Expected: one scope/count subtitle, as required by the design-behaviour rules; avoid repeating the same count and spending vertical space.

Evidence: [screenshot](evidence/reminders-today.png), [accessibility state](evidence/reminders-today.txt).

### QA-04 — Photos repeats the same success message (P3, visual)

Steps: open the first photo → Favorite → Info → scroll details to the bottom.

Actual: `Added to Favorites.` appears both inside the details and immediately above the floating action bar.

Expected: one persistent status line. Source corroboration: `PhotosLightboxView.swift` renders `state.status.sentence` in both `lightToolbar` and the Info content.

Evidence: [screenshot](evidence/photos-duplicate-status.png).

### QA-05 — Places map pins overlap with no way to separate them (P2, visual/usability)

Steps: Photos → Library destinations → Collections → Places → Map.

Actual: several nearby places stack over one another in the lower-left of the plot. Some thumbnails and counts are obscured, so those places cannot be reliably selected visually.

Expected: a way to reach each overlapping place on the map (for example, collision handling or zoom). The Cards alternative works. Source corroboration: `PlacesView.swift`’s `PlacesPlot` positions every button in a fixed-height plot and provides no zoom, pan, cluster or overlap-disambiguation interaction.

Evidence: [screenshot](evidence/photos-map-overlap.png).

### QA-06 — Money cash-flow amounts have no column labels (P2, usability/accessibility)

Steps: Home → Money → Cash flow.

Actual: each month has three amounts with no table headers identifying In, Out and Net. The legend identifies chart bars only. Accessibility announces only the month and net amount, omitting the visible income and spending amounts.

Expected: unambiguous labels for all three figures, available visually and to assistive technology. Source corroboration: `MoneyHomeView.swift:281` and `MoneyParts.swift`’s `MoneyMonthRow`.

Evidence: [screenshot](evidence/money-cashflow-unlabelled-columns.png), [accessibility state](evidence/money-cashflow-unlabelled-columns.txt).

### QA-07 — Health workout type is invisible (P2, visual)

Steps: Health → Workouts → Afternoon run on Sunday 8 November.

Actual: the activity-type chip above the title is a solid pink capsule with no legible icon or word. The accessibility heading includes `Run`. Re-observing after the transition gives the same blank chip.

Expected: the Run word and icon have sufficient contrast against the chip. `HealthWorkoutView.swift` sets both content and background through the Health accent.

Evidence: [screenshot](evidence/health-workout-blank-type-pill.png).

### QA-08 — “This week” is actually a rolling range (P2, date semantics)

Steps: on Tuesday 10 November 2026, open Health → Workouts.

Actual: Thursday 5, Saturday 7 and Sunday 8 November appear under `THIS WEEK`. Calendar in this same vault shows the week beginning Monday 9 November; Thursday and Saturday are from the prior week even if the locale started its week on Sunday.

Expected: calendar-week grouping, or a label that describes a rolling seven-day range. Source corroboration: `crates/screens/src/health/home.rs:404` subtracts `WEEK_BACK` from today instead of finding the week boundary.

Evidence: [screenshot](evidence/health-workouts-week-group.png).

### QA-09 — People permits turning off birthday reminders (P2, product contract)

Steps: People → Jake Bennett → tap the Birthday bell.

Actual: the row becomes `Reminder off`, and the action changes to turn it back on.

Expected: product-intuition’s apps-shell ruling says a person’s birthday reminder is always on. This is a documented product-contract mismatch; the UI toggle itself functions. The existing setting was turned back on.

Evidence: [screenshot](evidence/people-birthday-reminder-off.png).

### QA-10 — Empty channel has an enabled, silent Save (P2, functional feedback)

Steps: People → QA Mira Patel → Add channel → leave Value empty → Save.

Actual: Save is filled and enabled; tapping it leaves the sheet unchanged, with no validation message. In contrast, entering a malformed email produces a validation sentence.

Expected: disable Save until a value exists, or explain the missing value when submitted.

Evidence: [screenshot](evidence/people-empty-channel-save.png), unchanged state observed after tapping Save.

### QA-11 — Locker gives the wrong relock reason (P3, copy)

Steps: unlock Locker using simulated Face ID → create a metadata-only QA item → immediately press the simulator Home button → reopen Centraid.

Actual: Locker correctly relocks, but says `Locked after 5 minutes idle.` The app had just been active and saved an item; this relock was triggered by backgrounding.

Expected: say the app was left/backgrounded, or use a neutral lock notice. Do not claim the idle timeout fired.

Evidence: [screenshot](evidence/locker-background-wrong-lock-reason.png).

### QA-12 — Installed Centraid has the generic iOS app icon (P2, visual; local build)

Steps: after installing the fresh Debug build, press the simulator Home button.

Actual: Centraid’s SpringBoard icon is the white generic grid/blueprint icon. Other apps have their own icons. This was observed after the app had been running for many minutes, not only immediately after installation.

Expected: the generated Centraid app icon. Scope: this Xcode 27.1 / iOS 26.5 local build; release and pinned-Xcode builds are not established.

Evidence: [screenshot](evidence/shell-placeholder-app-icon.png).

### QA-13 — Journal hides Save without explaining required Mood (P2, usability)

Steps: Notes → Journal → New entry → enter journal text but leave Mood empty.

Actual: there is no Save action at all. The fields do not identify Mood as required and no validation sentence explains why the entry cannot be saved. Entering `Calm` into Mood makes Save appear and permits saving.

Expected: a discoverable Save with the missing requirement explained, or clearly marked required fields. Source corroboration: `crates/screens/src/notes/home/journal.rs` requires both fields; `NotesHomeView.swift` entirely omits its primary action while `canSave` is false.

Evidence: [screenshot](evidence/notes-journal-hidden-save.png), [accessibility state](evidence/notes-journal-hidden-save.txt).

### QA-14 — Journal displays an invented noon time (P2, date semantics)

Steps: create a Journal entry today at approximately 15:02, entering Mood and text; return to Journal.

Actual: the new `Calm` entry displays `12:00`. No time was entered or chosen.

Expected: show only the entry's day, or its actual creation time. Do not present a storage anchor as a real event time. Source corroboration: `crates/vault/src/commands/person.rs` deliberately files `journal_stamp` at noon; `crates/apps/notes/src/local.rs` exposes that stamp as a local time, which Journal renders.

Evidence: [screenshot](evidence/notes-journal-invented-noon.png), [accessibility state](evidence/notes-journal-invented-noon.txt).

### QA-15 — Chat's suggested document lookup fails with an edit error (P2, functional/copy)

Steps: create `QA travel checklist` in Docs → Home → Chat (Docs scope) → tap the offered `Find the QA travel checklist` suggestion.

Actual: after Thinking and Looking in Docs, Chat ends with `I could not settle this in 6 steps; the last thing that failed: error: edit needs field: value lines. document editable fields: name. Which did you mean?` It includes the correct document card alongside unrelated Notes and Locker cards. This simple lookup took roughly a minute and a half in this local simulator run. This is an observation, not a timing assertion or performance gate.

Expected: find/open the document without invoking an edit workflow or exposing internal tool validation to the member. Opening the returned card confirmed the document still had the expected body and four versions; no successful unwanted edit was observed. The model's internal call sequence has not been reconstructed.

Evidence: [screenshot](evidence/chat-find-document-edit-error.png), [accessibility state](evidence/chat-find-document-edit-error.txt).

### QA-16 — Chat document card uses UTC as unlabeled local time (P2, date/time)

Steps: inspect the QA document result from QA-15, then open it.

Actual: Chat labels the document `Today · 09:34`, while Docs details say `Added, Tue 10 November 15:04`. The difference is exactly the device's UTC+05:30 offset. Chat provides no UTC indicator.

Expected: consistent member-local display, or an explicit zone when another zone is intentional.

Evidence: [Chat screenshot](evidence/chat-find-document-edit-error.png); document details were inspected immediately afterward (40 bytes, four versions, Added 15:04).

### QA-17 — Settings and Backup contradict each other about recovery-key custody (P1, recovery guidance)

Steps: Home → Settings → read Recovery key; open Backup from Settings → scroll to Recovery key.

Actual: Settings says `Saved in iCloud Keychain. Sign in to iCloud on a new iPhone to restore your vaults.` Backup says `Only on this phone` and `Your recovery key is only on this phone. Lose it and your vaults can't be restored. Save a copy.` Neither saving nor changing key custody occurred between these observations.

Expected: both surfaces derive the same truthful custody state. A false assurance that a recovery key is saved can lead the member to lose their only recovery route. This audit establishes the contradiction; it does not establish which custody claim is true, or prove a real key loss. No key was revealed or exported.

Evidence: [Settings screenshot](evidence/settings-key-says-saved.png), [Backup screenshot](evidence/backup-key-only-on-phone.png), corresponding `.txt` snapshots.

### QA-18 — Money's import status covers the Done button (P2, visual/usability)

Steps: Money → More → Import statement → select the simulator's 190-byte `statement.csv` → Everyday → Import 6 rows → scroll to the bottom. Dark appearance, baseline text size.

Actual: `Imported 6 rows` occupies the bottom status pill, while only a thin blue upper sliver of the Done button is visible immediately above it. The Done label cannot be read. A further upward scroll does not expose it. Accessibility still lists the Done action.

Expected: the completion action remains fully visible and tappable, with enough bottom content inset for the status line. Import itself succeeded; re-selecting the same statement correctly showed New 0 / Already in 6 and offered no duplicate import action.

Evidence: [screenshot](evidence/money-import-done-clipped.png), [accessibility state](evidence/money-import-done-clipped.txt).

### QA-19 — Larger text breaks Calendar's time gutter and year grid (P2, visual/accessibility)

Steps: increase simulator text size twice from the audit baseline through Device → Accessibility → Increase Text Size. Calendar → Day / Week, then View → Year. Dark appearance.

Actual: the time gutter wraps `20:00` as `20:0` followed by `0` on a new line. The Year view retains three miniature months across, and dates run together without legible separation; some wrap into additional rows. The Week headers also crowd together.

Expected: adapt widths, typography or layout so hour labels remain intact and individual year dates can be distinguished at supported text sizes. The two text-size changes were reversed afterward.

Evidence: [time gutter](evidence/calendar-large-text-hour-wrap.png), [year grid](evidence/calendar-large-text-year-crowding.png).

### QA-20 — Closing Photos search loses Collections context (P3, navigation)

Steps: Photos → Library destinations → Collections → Search → enter `Tahoe` → Close search.

Actual: closes into Library / All, replacing the Collections destination and its navigation band. Reproduced in both the initial light pass and the later dark/larger-text pass.

Expected: return to Collections, where search was entered, preserving the member's navigation context.

Evidence: [returned Library screenshot](evidence/photos-search-loses-collections.png), [accessibility state](evidence/photos-search-loses-collections.txt). Collections and search result state were observed immediately before closing.

### QA-21 — Home says “No events today” after today's events have ended (P3, copy)

Steps: inspect Calendar's Tuesday 10 November events (Morning run, Sprint planning, 1:1 with Jake ending 15:15), then return Home after 15:15.

Actual at 15:23: Calendar's Home tile says `No events today`, despite the three events already held today. The tile's accessibility label separately says `9 on your plate`.

Expected: distinguish an empty calendar day from a day whose remaining events have finished, for example `No more events today`, and keep the tile's spoken summary consistent with its visible state.

Evidence: [Home screenshot](evidence/home-no-events-after-last-event.png), [accessibility state](evidence/home-no-events-after-last-event.txt); Calendar's events were inspected earlier in the same pass.

## Observations requiring qualification

- The demo’s `Tahoe shoreline pan` video opens with `Preview no longer on this phone` and a 0:00 / 0:00 transport, although its library badge says 0:12. Missing fixture media has not yet been distinguished from a playback defect. [Evidence](evidence/photos-video-unavailable.png).
- Health’s compact pinned cards omit the `Nothing yet today` wording visible on wide cards, and the Weight card omits its `Yesterday` age while accessibility includes it. [Evidence](evidence/health-summary-missing-readings.png). Check the board’s intended compact presentation before classifying.
- Additional design-contract drift was observed: Notes exposes Notebooks as a band tab despite the product rule saying notebooks must not be a band tab; Docs retains label chips under the subtitle despite the funnel-only filter rule; the Docs overflow uses an option sheet rather than the specified native menu. These need reconciliation with the committed boards before a visual redesign; no speculative fix was made.
- Journal's explanatory copy says entries are written in People, even though Notes now offers New entry and successfully creates them. Update that copy alongside the Journal validation/date fixes.
- Cancelling pairing started from Backup returned to Home. Source-route preservation was not independently repeated, so this remains a navigation follow-up rather than a confirmed finding.

## Coverage

| App | Exercised | Result / limits |
| --- | --- | --- |
| Calendar | Today timeline; overlapping events; create `QA picnic with Mira`; change start time (end follows by one hour); select 30-minute reminder; save; reopen and inspect persisted fields; cancel through confirmation; search Sprint and dentist; Calendars sheet; Day/Week/Month/List/Year in dark/larger text | Core flows worked. QA-02, QA-19, QA-21. Cancelled QA event is retained as cancelled. Advanced recurrence, imports and invitations were not exercised. |
| Reminders | Smart-list counts; Today/Overdue; create `QA buy oat milk` in Errands; complete and Undo; change due day to Tomorrow; autosave notes and reopen; add subtask `Check the fridge first`; delete parent through confirmation; Trash contains parent and child; restore parent empties both Trash rows; Catch up; dark/larger-text root and detail | Core flows worked. QA-01–03. Final inspection confirmed the restored reminder's Tomorrow date, notes and 0-of-1 subtask relationship. |
| Photos | Library, individual photos, next-photo navigation, Favorite, Info and scrolling, manual people tag and unlink, video entry, Months view, Collections/Albums, Places Cards/Map, caption/album search, edge swipe Home; dark/larger-text Library/Collections/search | QA-04–05, QA-20. First photo's Favorite state was restored to off (Favorites back to 7). Video caveat above. No OS photo permission granted. |
| Money | Activity, uncategorized review, category picker/save, return to filtered empty state, clear filters, Spending Week/Day, category target sheet, negative target rejection and cancel, Cash flow, Accounts balances; dark Activity/detail; CSV chooser, account selection, six-row preview, import, same-file duplicate detection, Start over | QA-06, QA-18. Monthly service fee category restored to its original No category state. Six sample October rows remain imported in Demo Everyday. No void, payment, bank connection or external transaction. OFX/QFX and malformed CSV were not exercised. |
| Health | Summary, Steps Week/Month/Year, chart touch, Workouts list/detail, More and What Health may read; Trends 30/90 days/Year; dark/larger-text Summary and Trends | QA-07–08; compact-card caveat above. Existing synthetic history; no real Health data or permission changes. |
| People | Existing profile and related events/tasks, birthday toggle and restore, create QA person with role/cadence, alphabet jump, empty and malformed channel validation, save valid test email, log Met up touch, delete/restore person; dark/larger-text list and restored profile | QA-09–10. Final inspection confirmed restored email and touch history. Synthetic data only. No call/message/email sent. |
| Locker | Leave during pending Face ID (prompt dismisses), simulated successful Face ID, All metadata list, passkey storage detail, Review, new metadata-only login, dirty-draft discard prompt and Cancel, explicit Save, background/reopen relock; dark/larger-text locked entry | QA-11. QA library login saved without a secret. No secret reveal/copy/export; physical capture shielding not established. |
| Notes | Open existing checklist; toggle and Undo; create a body-first note and reopen autosaved text; file in Travel; follow resolved internal note link and missing-link fallback; Journal empty state, compose required fields, save and open entry; dark/larger-text root/editor; show software keyboard and inspect toolbar avoidance | QA-13–14. Synthetic packing note, People touch note and Calm journal entry remain in Demo. Fast multiline/keyboard-shortcut input through automation was ambiguous; separate Return and typing persisted a paragraph, so no data-loss claim is made. Keyboard toolbar remained above the software keyboard. |
| Docs | PDF preview, labels add/remove, new text document and rename, autosave/reopen, version history restore empty version then restore content, file in Travel, recoverable Trash and restore, contents search, Browse/Travel, Starred, Scan permission-denial path and retry; dark/larger-text Recents | QA document remains in Travel with correct 40-byte body and four versions. Camera denied; native Camera Unavailable alert explains Settings recovery. No Docs OS file import executed. |
| Shell / Chat / Backup | All nine launchers; app background/reopen; Chat suggested document lookup, result-card opening, history; Backup status and per-app counts, pairing setup with invalid synthetic code, validation and Cancel; Settings appearance and recovery status; global QA search finds Docs/Calendar/Reminders/Notes/People/Locker/Chats | QA-12, QA-15–17, QA-21. No gateway paired, backup transferred, recovery key revealed/saved/exported, or live vault opened. Appearance restored; left on Demo Home. |

## Performance, flicker and remaining limits

- No application crash or unrecoverable UI hang was observed during this pass. Ordinary navigation and edits generally completed while interacting. This is qualitative manual evidence, not a latency, memory, energy or frame-time benchmark.
- Chat's simple lookup spent roughly a minute and a half generating/tool-running before its failed response (QA-15). It continued showing progress. Device/model/runtime effects have not been separated, so no physical-device performance conclusion is claimed.
- No persistent flicker was confirmed. Single snapshots of native transitions sometimes contained a prior view; this is insufficient to classify flicker. Frame-by-frame animation/scroll recording on physical hardware remains untested.
- This pass used one iPhone simulator in portrait, the existing Demo corpus, light/dark and two larger-text increments. Small phones, iPad, landscape, all accessibility sizes, VoiceOver traversal, long/offline sessions, real permissions/data sources, camera capture, real media playback, background task delivery and a paired gateway were not covered exhaustively.
- No code was changed or fixed. The successful local Debug build is the build verification for this audit; no repository gate is claimed. Follow-up fixes should run the gate profile required by AGENTS.md.

## Demo data left for reproduction

- Cancelled event `QA picnic with Mira`; restored `QA buy oat milk` reminder and `Check the fridge first` subtask.
- Restored contact `QA Mira Patel`, synthetic email and Met up touch; corresponding `met up` note.
- Metadata-only `QA library login` (no secret), Travel packing note, Calm journal entry, and Travel document `QA travel checklist` with four versions.
- Six rows from the simulator's sample `statement.csv` in Money → Everyday (October 1–15; WHOLE FOODS, COFFEE CO, PAYROLL, SHELL FUEL, NETFLIX, GROCER D). Repeat preview detected all six as Already in.
- Existing photo Favorite and Money service-fee category changes were restored. The birthday reminder was turned back on. Camera permission remains denied following the denial-path test. No permanent Trash purge was performed.
