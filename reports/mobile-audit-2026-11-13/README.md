# Mobile audit fixes: review snapshot

This is an incomplete audit of the main app and nine mini apps following #1185. The PR is a draft. Native Android/iOS observations, shared regressions and builds are distinct evidence; a passing build does not mean every workflow passed.

The audit started on `96bf41246`. Main subsequently advanced to `c960911b4` through #1190, which substantially changes notifications, backup and chat. This branch preserves the audited implementation and needs reconciliation with that newer main before merge. Validation below describes the audited branch, not the newer main or a merged result.

## Changes included

- Repair Android Home card measurement, icons, theme contrast and native lifecycle handling.
- Add safe inline text previews for supported text files, preserving original bytes for export; handle missing originals truthfully and repair attachment return routes.
- Repair recovery key retention and cold reopening, original fetch/adoption, pending-backup wording and visible app item counts while keeping shared byte accounting unchanged.
- Rearm reminders after permission changes; retain delivered alerts until acted on or dismissed; persist notification Undo receipts and correlate native completion with the exact performed answer.
- Repair iOS sheet navigation, recovery-key cancellation, row hit regions, video MIME handling, paused duration and truthful share cancellation. Successful status lines use ordinary ink and retain their Undo action.
- Make Android's time picker follow the phone's hour format. Increase enabled iOS checkbox outline contrast using an existing color role.
- Align reminder list dots to the first title line's font cap height, including wrapped titles and Dynamic Type. Keep the existing dot size and row geometry.

Light mockups were updated first and dark/native outputs generated. No lint, test, count/size budget or allowlist was relaxed. Static startup-phase diagnostics are DEBUG-only and accept fixed phase names, counts and booleans, not notification payloads or secrets.

## Recorded validation

| Layer | Result and limit |
| --- | --- |
| Android native build | Latest `de1702d7f720` package: 135 tests, zero failures/errors/skips. Actual installed APK and embedded core bytes matched the preserved artifact. |
| iOS native build | Latest `4ba22b229328` / core `25f7ea4cfa87`, including dot alignment, checkbox contrast and DEBUG diagnostics: full 106 Swift tests, zero failures/skips or warnings; pre/post bundle identical and all 54 installed bundle files matched. Actual dot alignment also passed native light/dark checks at normal and largest text sizes, including three-line titles; this does not pass broader accessibility. |
| Real JVM binding | Latest `cargo xtask gate --profile mobile-jvm`: 44 tests passed. |
| Shared regressions | Focused backup/count, notification durability/retention, Photos lightbox and Notes/People regressions passed. Their overlapping groups are not added into a misleading total. |
| Design and static checks | Canonical design emission/check passed for 295 files; formatting, rules and workspace all-target clippy passed on the recorded batch. |
| Full local gate | Intentionally interrupted during runtime tests for authorized source follow-up. There is no final full-local or PR-profile PASS for the complete PR snapshot. Required final gates remain outstanding. |

Actual device evidence includes Android backup/recovery and original export checks; light/dark text preview and byte-preserving roundtrips; native video motion, pause, seek, EOF/replay; delivered-alert retention through foreground reconciliation; and OS dismissal without reposting. iOS native Docs exports/reimports passed 34 exact-byte checks across both themes. Photos filtered exports preserve compressed and decoded video/audio content; the fixture has no GPS, so this is not a positive GPS-removal test. Native Notes ZIPs and Reminders ICS exports were saved through Files in both themes. Calendar, attachment, Notes Trash/Undo and Locker masked Star/history checks also have native evidence.

The current iOS coverage ledger has **82 narrow passes, 3 failed cases, 8 explicit N/A groups and 96 unrun cases (189 total)**. Partial observations do not complete their broader workflow groups.

## Outstanding before merge

1. **Cold iOS notification actions:** the latest real Done action launches the app in the background, but the task remains open and no confirmation/Undo receipt appears. OS assertion expiry is recorded. Fake-core readiness tests do not resolve this failure; DEBUG phase diagnostics are included to locate it.
2. **Main Search/Ask navigation:** closing Search after returning from Ask can strand results and the keyboard without Home; Ask also shows duplicate back controls.
3. **Calendar accessibility:** the fixed grid clips labels/events at the largest text size. Navigation success is not a usable-layout pass.
4. **Direct Trash consistency:** Reminders detail, People person and Docs Drive/document still ask before reversible Trash. Their four-path repair was prepared but not implemented in this snapshot. Purge, Empty trash, series cancellation, owner checks and conversation confirmation remain separate rules.
5. **Reminder history time:** a preview displays the raw UTC clock rather than the phone-zone clock; this is a source-backed candidate requiring repair and retesting.
6. **Incomplete execution:** fresh iOS recovery, cold notification inverses/dismissed receipts, remaining uniform workflows and accessibility cases remain unrun. Dot visual spot checks passed separately; remaining control interactions and layouts still need their own verification.
7. **Locker export:** automatic approval review rejected the all-secrets export test. The rejected action did not run; the guarded file export remains unverified.
8. Reconcile with #1190 and run the final appropriate gate profiles against the resulting branch.

## Published material

Only application/core code, regression tests, mockups and this sanitized summary are included from this audit. Raw screenshots, captures, generated demo mnemonic logs, temporary Java diagnostics, recovery words, pairing payloads, private OS diagnostics, binaries and the roughly 688 MB local evidence tree are excluded. Deterministic public test fixtures in source remain test fixtures. The bounded accidental-material scan is not a full security audit.
