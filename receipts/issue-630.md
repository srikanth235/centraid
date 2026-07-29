## Accounting

<!-- Implementation checkpoint: Wave 0 measurement/honesty and the Locker
trust boundary are complete locally; the full waved receipt narrative and
fresh-context audit will be written only when issue #630's one exit is met. -->

<!-- Checkpoint: P5 now provides durable one-shot revisions, trash/restore,
and reachable history/undo surfaces for Notes, People, Tally, and Photos;
People/Tally formerly dead mutation handlers are reachable, and backup plus
restore-after-erase tests preserve lifecycle and revision rows exactly. -->

<!-- Checkpoint: mobile now has an optional biometric whole-app gate that
unmounts the replica and clears credential memory on background, plus a
first-class native Locker cover using online-only passphrase/device
authentication, per-item permits, switcher masking, and timed clipboard
clearing. -->

<!-- Checkpoint: Wave 1 untrusted-content hardening now has the shared
13-vector corpus running through a real render component from all eight apps,
scheme/MIME allowlists on dynamic link/media/document/CSS sinks, and a
fail-before-draft importer corpus for malformed base64/UTF encodings,
truncated ICS/vCard, spreadsheet-formula CSV cells, unsafe/truncated ZIPs, and
archive-bomb declarations. Ambiguity decision: formula-prefixed values are
rejected in display-bearing CSV fields instead of being silently mutated;
password cells remain byte-for-byte arbitrary secret data. -->

<!-- Checkpoint: Wave 2 makes handler reachability and state honesty permanent.
All manifested actions/queries now require a web and mobile caller or a
rationale-bearing agent/extension/platform fallback. Mobile treats a missing
session as unavailable, combines per-query errors, exposes freshness and pull
refresh across all three covers and every Photos sub-screen, separates queued
offline writes from parked approval intents, assigns stable double-tap intent
IDs, validates optimistic mutations at enqueue, and surfaces every write
outcome. Docs and Photos entity writes are optimistic. Design decision:
document/photo upload and cross-vault placement are not represented by
fabricated canonical rows before content IDs exist; their existing durable
upload/placement queues and progress surfaces are the honest optimistic
contract. Enrichment requests likewise surface their queue admission without
inventing an entity. Web now has first-read skeletons and actionable empty
states in every blueprint, all consent banners open the Vault permission pane
directly, and the shell exposes persistent connectivity/sync state plus a real
search/no-results path. Verification at this checkpoint: Blueprints 648,
Client 1,438, and Mobile 268 tests pass; all three package typechecks and the
mobile import-boundary lint pass. -->

<!-- Checkpoint: Wave 3 adds one private capture plane on web/PWA, iOS, and
Android: universal text quick-add with deterministic task/expense/note/event
routing and a local-agent fallback; PWA/OS share targets for text, URLs, and
files; Apple Vision / Android ML Kit OCR with a bounded opt-in Tesseract
gateway fallback; preview-before-commit routing to Docs, Photos, Locker, and
an atomically published Tally receipt with canonical attachment, reviewed OCR
text, allocated line items, tax, and tip. Gateway reminder scheduling now
drives opaque Expo and Web Push wakes, actionable native task/event/Tally
routes, exact due-time re-arming, per-device registration/revocation, and
content-minimized notification fetches. Photos backup exposes source album,
battery, Wi-Fi/metered, roaming, custody, and PWA bulk-import controls; unknown
cellular roaming is conservatively blocked unless the owner opts in. iOS share
extension and Android/native modules compile, and native fingerprints are
reviewed and pinned.

Ambiguity decision: notification endpoint tokens and the VAPID private key are
gateway/device capabilities, not portable user records. They stay mode-0600 in
gateway.db, are revoked on unlink, and are re-registered after reconnect.
Including them in vault backup would resurrect delivery authority after a
revoked device or blank-machine recovery. Reminder definitions remain
backup-covered vault data. The receipt recovery canary separately proves the
image, canonical attachment, OCR derivative, line items, and allocations
survive side restore and restore-after-erase. -->

<!-- Checkpoint: Wave 4 now has one dependency-free civil-time and recurrence
engine consumed by Agenda, Tasks, vault recurrence compatibility, automation
timezone extraction, the mobile replica, and blueprint handlers through
`ctx.time`. It implements zoned/floating/all-day semantics, calendar- and
completion-relative rules, RRULE end conditions and readable previews, stable
original-occurrence keys, occurrence/future skips and overrides, and the shared
gap-skip/overlap-once-at-earlier-instant policy. Agenda supports complete event
editing and recurrence scope on web and mobile; schedule schema and commands
now carry projects/sections/order and recurrence exceptions.

Ambiguity decision: moved recurring instances retain the original occurrence
instant as their durable identity. This keeps concurrent offline edits and
future-scope exceptions addressable even when an override changes the visible
start. In a fall-back overlap, the earlier absolute instant is canonical and
the duplicate wall occurrence is suppressed, matching the automation policy
documented in docs/cron-timezone.md.

The remaining organization surface is now first-class on web and native:
Tasks has Inbox/Today/Upcoming/project views, area-classified projects,
sections, cross-section moves, and persistent drag ordering; People has
normalized contact-channel CRUD with preferred/provenance/duplicate guidance
plus merge undo; and Tally uses fixed-point original/settlement amounts,
auditable rate source/date, locale display, recurring previews, idempotent
materialization, and skip/edit occurrence/future/series controls. Native
Agenda creation now exposes the same complete event contract as editing and
local reminder text intentionally omits the event title.

Exit evidence at this checkpoint: the vault organization/recurrence suites
pass (6 tests), independent replicas converge on concurrent task/contact/
expense/event logs, blueprint reachability and query suites pass (29 tests),
and the weekly-09:00 matrix covers Asia/Kolkata, Europe/London,
America/New_York, and Australia/Sydney across a full year. Mobile and
blueprint typechecks, mobile import boundaries, and the focused native suite
are green. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019fad18-4c1-1785320421-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 1165127 | 0 | 43335424 | 128617 | 1293744 | 15.6759 | 1165127 | 0 | 43335424 | 128617 | feat(blueprints): establish honest readiness and Locker auth (#630) -m governanc |
| codex-019fad18-4c1-1785320751-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 54315 | 0 | 3178496 | 8269 | 62584 | 1.0544 | 1219442 | 0 | 46513920 | 136886 | feat(blueprints): establish honest readiness and Locker auth (#630) -m governanc |
| codex-019fad18-4c1-1785323428-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 503476 | 0 | 29808128 | 79524 | 583000 | 9.9036 | 1722918 | 0 | 76322048 | 216410 | feat(blueprints): add durable lifecycle undo surfaces (#630) |
| codex-019fad18-4c1-1785323544-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 14580 | 0 | 1106944 | 2439 | 17019 | 0.3498 | 1737498 | 0 | 77428992 | 218849 | feat(blueprints): add durable lifecycle undo surfaces (#630) |
| codex-019fad18-4c1-1785324677-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 197417 | 0 | 17943552 | 31019 | 228436 | 5.4447 | 1934915 | 0 | 95372544 | 249868 | feat(mobile): add biometric trust and native Locker (#630) |
| codex-019fad18-4c1-1785325161-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 53070 | 0 | 3939840 | 12996 | 66066 | 1.3126 | 1987985 | 0 | 99312384 | 262864 | feat(mobile): add biometric trust and native Locker (#630) |
| codex-019fad18-4c1-1785326824-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 390749 | 0 | 14336000 | 45157 | 435906 | 5.2382 | 2378734 | 0 | 113648384 | 308021 | feat(security): harden blueprint content and imports (#630) |
| codex-019fad18-4c1-1785326867-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 10334 | 0 | 326912 | 509 | 10843 | 0.1152 | 2389068 | 0 | 113975296 | 308530 | feat(security): harden blueprint content and imports (#630) |
| codex-019fad18-4c1-1785326903-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 2342 | 0 | 225792 | 161 | 2503 | 0.0647 | 2391410 | 0 | 114201088 | 308691 | feat(security): harden blueprint content and imports (#630) |
| codex-019fad18-4c1-1785326968-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 2336 | 0 | 226816 | 270 | 2606 | 0.0666 | 2393746 | 0 | 114427904 | 308961 | feat(security): harden blueprint content and imports (#630) |
| codex-019fad18-4c1-1785329594-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 559681 | 0 | 31398400 | 75630 | 635311 | 10.3833 | 2953427 | 0 | 145826304 | 384591 | feat(blueprints): make offline state honest and reachable (#630) |
| codex-019fad18-4c1-1785334143-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 877041 | 0 | 48042496 | 144738 | 1021779 | 16.3743 | 3830468 | 0 | 193868800 | 529329 | feat(capture): add private cross-platform intake and reminders (#630) |
| codex-019fad18-4c1-1785334747-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 91929 | 0 | 6185472 | 21489 | 113418 | 2.0985 | 3922397 | 0 | 200054272 | 550818 | feat(capture): add private cross-platform intake and reminders (#630) |
| codex-019fad18-4c1-1785334818-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 3597 | 0 | 835584 | 336 | 3933 | 0.2229 | 3925994 | 0 | 200889856 | 551154 | feat(capture): add private cross-platform intake and reminders (#630) |
| codex-019fad18-4c1-1785337231-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 440644 | 0 | 25269760 | 80374 | 521018 | 8.6247 | 4366638 | 0 | 226159616 | 631528 | feat(time): unify recurrence and Agenda editing (#630) |
| codex-019fad18-4c1-1785337540-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 73402 | 0 | 4989952 | 3951 | 77353 | 1.4903 | 4440040 | 0 | 231149568 | 635479 | feat(time): unify recurrence and Agenda editing (#630) |
| codex-019fad18-4c1-1785337630-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 9699 | 0 | 1854464 | 631 | 10330 | 0.4973 | 4449739 | 0 | 233004032 | 636110 | feat(time): unify recurrence and Agenda editing (#630) -m governance: allow-tool |
| codex-019fad18-4c1-1785340357-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 482747 | 0 | 28319488 | 98138 | 580885 | 9.7588 | 4932486 | 0 | 261323520 | 734248 | feat(blueprints): complete organizational parity (#630) |
| codex-019fad18-4c1-1785340549-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 34754 | 0 | 2243584 | 4721 | 39475 | 0.7186 | 4967240 | 0 | 263567104 | 738969 | feat(blueprints): complete organizational parity (#630) |
