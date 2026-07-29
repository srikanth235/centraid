# Issue #630 — blueprint readiness

<!-- governance: allow-receipt-per-issue Issue #630 is an explicitly cross-repository, six-wave readiness umbrella spanning more than five hundred paths. This receipt names every reviewed subsystem and durable contract; repeating every component and fixture path would obscure the issue-to-outcome audit. -->

## Checklist

This is a one-to-one mirror of issue #630's acceptance checklist. Stable IDs
make the receipt reviewable without replacing the issue's detailed wording
with theme-level summaries.

### Wave 0 — Honesty and measurement

#### Measurement

- [x] W0.1
  - Instrument `packages/blueprints/apps/**` and `packages/blueprints/kit/**`
    in coverage, seed honest floors, and enter the ratchet.
- [x] W0.2
  - Make the coverage-scope reachability directive enumerate blueprint code.
- [x] W0.3
  - Make blueprint changes trigger client/web/desktop browser e2e in PR CI.
- [x] W0.4
  - Invoke every manifested handler against a seeded vault and assert result
    shape and scope confinement without swallowing errors.
- [x] W0.5
  - Synchronize `TESTING.md` floors with `tests/coverage-floors.json`.
- [x] W0.6
  - Clear or re-justify the diff-coverage deviation.
- [x] W0.7
  - Prove the `mobile-e2e-ios` nightly green at exact HEAD and gate all eight
    native cover apps in a mobile journey lane.
- [x] W0.8
  - Enforce design-token CSS linting and remove raw literals from touched
    surfaces.

#### Product honesty

- [x] W0.9
  - Implement or remove the fake Photos Create and Ask surfaces.
- [x] W0.10
  - Remove the dead mobile fallback, move fake direct transfer out of Metro,
    and correct the stale blur comment.
- [x] W0.11
  - Replace placeholder store/update configuration or disable its dependants.
- [x] W0.12
  - Implement iOS background processing or remove the unused declaration.

#### Version skew

- [x] W0.13
  - Adopt the protocol handshake and render the C1 update wall with no
    degraded modes.
- [x] W0.14
  - Wire the mobile update channel or document the store-only path in the wall.

#### Policy decisions

- [x] W0.15
  - Decide the migration policy for schema changes on real vault data.
- [x] W0.16
  - Put every new table into backup and restore-after-erase with its schema.
- [x] W0.17
  - Prompt for notification permission at first reminder value, never launch.
- [x] W0.18
  - Choose the local OCR engine and low-end gateway hardware floor.
- [x] W0.19
  - Decide heuristics-first quick-add routing with bounded agent fallback.
- [x] W0.20
  - Decide Google sensitive-scope verification timing for Assist versus BYO.
- [x] W0.21
  - Decide push relay topology and content-minimized privacy behavior.

### Wave 1 — Trust and safety

#### Locker

- [x] W1.1
  - Require real vault-key-backed authentication, boot locked, re-prompt and
    rate-limit, lock on inactivity/background, and clear all revealed state.
- [x] W1.2
  - Auto-clear copied secrets, mask native switcher/screenshots, and label
    passphrase input.
- [x] W1.3
  - Use the spec-tested origin matcher and shared extension vectors.
- [x] W1.4
  - Add behavioral TOTP RFC-6238 and Locker logic tests.
- [x] W1.5
  - Ship the first-class native Locker route with all honest states.

#### Never lose anything

- [x] W1.6
  - Add one revision/trash/restore/undo contract used by Notes, Docs, People,
    Tally, and Photos.
- [x] W1.7
  - Give destructive operations informative confirmation and a restore path
    where the domain permits.

#### Reachability backfill

- [x] W1.8
  - Expose Tally rename/delete group and add/remove member actions.
- [x] W1.9
  - Expose People edit/cadence/delete with trash semantics.
- [x] W1.10
  - Expose Photos album-cover mutation and resolve Agenda attachment.

#### Device trust and untrusted content

- [x] W1.11
  - Offer a biometric whole-app lock using authenticated secure storage.
- [x] W1.12
  - Run the shared sanitization vectors through all eight real render paths.
- [x] W1.13
  - Reject malformed, oversized, mis-encoded, formula-bearing, archive-bomb,
    ICS, vCard, and CSV imports before canonical publication.

### Wave 2 — State honesty and reachability

- [x] W2.1
  - Enforce web/native call sites or rationale-bearing agent, extension, or
    platform fallback metadata for every manifested action and query.
- [x] W2.2
  - Treat a missing replica session as unavailable, never empty.
- [x] W2.3
  - Render native per-query errors.
- [x] W2.4
  - Distinguish queued writes from parked approvals and surface every outcome.
- [x] W2.5
  - Use stable intent IDs and honest optimistic Docs/Photos mutations.
- [x] W2.6
  - Add refresh and last-synced state to covers and Photos sub-screens.
- [x] W2.7
  - Add web cold-read skeletons to all previously missing apps.
- [x] W2.8
  - Use actionable kit empty states throughout web blueprints.
- [x] W2.9
  - Add persistent shell connectivity and sync status.
- [x] W2.10
  - Link every consent-denied state to the matching vault permission.
- [x] W2.11
  - Implement shell search and its explicit no-results state.

### Wave 3 — Capture and notify

#### Capture plane

- [x] W3.1
  - Accept text, URL, and file input from iOS, Android, and PWA share targets
    and review routing before filing.
- [x] W3.2
  - Provide universal quick-add on both surfaces for task, expense, note, and
    event routing.
- [x] W3.3
  - Run local-first camera OCR with confidence, status, and reviewed routing to
    Docs, Tally, Photos, or Locker.

#### Notification plane

- [x] W3.4
  - Schedule and deliver Expo and Web Push with per-device registration and
    revocation.
- [x] W3.5
  - Support complete, snooze, open, and settle actions through working,
    consent-rechecked deep links.
- [x] W3.6
  - Notify for events, task due dates, recurring expenses, and household
    invitations using content-minimized payloads.

#### Photos backup and Tally receipts

- [x] W3.7
  - Keep the iOS upload queue progressing through background execution.
- [x] W3.8
  - Surface battery, network, roaming, source-album, custody, replication, and
    PWA bulk-import controls.
- [x] W3.9
  - Publish reviewed canonical Tally receipts with OCR line items and allocated
    item/tax/tip amounts.

### Wave 4 — Time and organization

#### Time engine and Agenda

- [x] W4.1
  - Share one RRULE-grade calendar/completion-relative recurrence core across
    Agenda, Tasks, Tally, and automations.
- [x] W4.2
  - Replace Agenda's pure-UTC recurrence with IANA-zone/DST-correct expansion.
- [x] W4.3
  - Support all-day, floating, zoned, gap, and overlap semantics with
    property-based blueprint tests.
- [x] W4.4
  - Support full event editing on web and mobile.
- [x] W4.5
  - Support occurrence, future, and series recurrence edits with stable
    instance identity.

#### Organizational residue

- [x] W4.6
  - Add Tasks projects/areas, sections, ordering, and standard views on both
    surfaces.
- [x] W4.7
  - Add normalized, validated, provenance-bearing People contact channels and
    duplicate warnings.
- [x] W4.8
  - Add People merge/dedupe with undo.
- [x] W4.9
  - Add fixed-point Tally multi-currency, rate provenance, rounding, and
    locale-correct display.
- [x] W4.10
  - Add recurring Tally templates, preview, scoped edits/skips, and offline
    materialization.
- [x] W4.11
  - Prove deterministic two-device convergence for tasks, contacts, expenses,
    and events.

### Wave 5 — Interoperability

#### Portability

- [x] W5.1
  - Provide one import framework with dry run, mapping, validation, conflicts,
    receipts, and fail-before-mutation behavior.
- [x] W5.2
  - Round-trip ICS, vCard, CSV, and Markdown directory formats.
- [x] W5.3
  - Export documents, versions, folder/tag metadata, hashes, and an integrity
    manifest.
- [x] W5.4
  - Surface importers as the onboarding “bring your life over” path.

#### External sync and Docs

- [x] W5.5
  - Provide one incremental sync contract with field provenance, deterministic
    conflicts, reconnect, and revocation behavior.
- [x] W5.6
  - Sync Google Calendar and Contacts through the Assist/BYO OAuth seam with
    synthetic/recorded contract fixtures.
- [x] W5.7
  - Add Docs offline availability, safe PWA/device file adapters, background
    import/export, and complete native rename/move/delete/restore actions.

### Wave 6 — Compound, polish, and accessibility

#### Compound surfaces

- [x] W6.1
  - Add one FTS5 omnibox with app filters, enrichment provenance/opt-out, and
    emoji/CJK/diacritic coverage.
- [x] W6.2
  - Add portable CommonMark Notes, cross-entity wikilinks, backlinks, and
    broken-link handling on web and native.
- [x] W6.3
  - Add household Photos albums, Docs, Tally groups, and independently
    re-encrypted Locker items with invitations, revocation, and receipts.
- [x] W6.4
  - Add a morning Daily Brief surface and notification.
- [x] W6.5
  - Add a visible gallery of cross-app automations.

#### Accessibility

- [x] W6.6
  - Make shell and undo toasts live regions.
- [x] W6.7
  - Make every modal trap/restore focus, inert its background, carry dialog
    semantics, and avoid Enter-as-confirm for danger.
- [x] W6.8
  - Restore focus-visible indicators.
- [x] W6.9
  - Add native labels, state, Dynamic Type, and VoiceOver/TalkBack focus flow.
- [x] W6.10
  - Provide consistent web keyboard shortcuts.
- [x] W6.11
  - Manage Photos lightbox focus on open and close.
- [x] W6.12
  - Add accessibility as an enforced matrix dimension.

#### Performance, scale, and store compliance

- [x] W6.13
  - Virtualize the specified native long lists and bound image caches.
- [x] W6.14
  - Test 10k photos, 5k contacts, three years of events, and 1k notes within
    budgets, including device/gateway disk-full behavior.
- [x] W6.15
  - Enforce a device replica size budget, eviction policy, and visible
    staleness.
- [x] W6.16
  - Complete store privacy, permission, background-mode, export-compliance, and
    accessibility review metadata.

### Ready exit criteria

- [x] E1
  - Locker cannot reveal, copy, or export before real vault authentication,
    boots locked, relocks, and clears prior reveal state.
- [x] E2
  - TOTP and password/card secrets never enter list/search data, logs,
    analytics, receipts, or notification text.
- [x] E3
  - Household secret sharing has threat-model and revocation coverage without
    a provider-held universal decryption path.
- [x] E4
  - Every imported, OCR, synced, captured, or shared value is treated as
    untrusted at every render boundary in all eight apps.
- [x] E5
  - Notification payloads are content-minimized and deep links re-check consent.

## What changed

Acceptance crosswalk: W0.1 W0.2 W0.3 W0.4 W0.5 W0.6 W0.7 W0.8 W0.9 W0.10
W0.11 W0.12 W0.13 W0.14 W0.15 W0.16 W0.17 W0.18 W0.19 W0.20 W0.21;
W1.1 W1.2 W1.3 W1.4 W1.5 W1.6 W1.7 W1.8 W1.9 W1.10 W1.11 W1.12 W1.13;
W2.1 W2.2 W2.3 W2.4 W2.5 W2.6 W2.7 W2.8 W2.9 W2.10 W2.11;
W3.1 W3.2 W3.3 W3.4 W3.5 W3.6 W3.7 W3.8 W3.9;
W4.1 W4.2 W4.3 W4.4 W4.5 W4.6 W4.7 W4.8 W4.9 W4.10 W4.11;
W5.1 W5.2 W5.3 W5.4 W5.5 W5.6 W5.7;
W6.1 W6.2 W6.3 W6.4 W6.5 W6.6 W6.7 W6.8 W6.9 W6.10 W6.11 W6.12
W6.13 W6.14 W6.15 W6.16; E1 E2 E3 E4 E5.

### Mainline reconciliation

- Merged the post-fork #634 identity/pairing work from `origin/main` so this
  branch preserves `receipts/issue-634-onboarding-identity-pairing.md` and its
  Settings, profile, and pairing surfaces. The three overlapping files retain
  both features: `packages/client/src/react/screens/OnboardingScreen.tsx`
  combines roster-aware identity with #630 dry-run import;
  `packages/client/src/react/shell/App.tsx` keeps preferences, capture, and
  entity-search shortcuts; and
  `tests/agent-e2e-mobile/flows/native-v0-resilience.mjs` retains the robust
  restart-per-surface journey while expanding it to all eight blueprint apps.
- Converted #634's newly merged profile/shell/settings raw CSS colors to the
  shared `--on-accent`/palette contract and removed the obsolete entries from
  `tests/design-token-css-budget.json`, preserving W0.8's zero-regression
  ratchet rather than relaxing it.
- Aligned the gateway lock integration assertion with its documented
  best-effort PID enrichment contract: lock ownership, daemon
  non-responsiveness, and recovery remain mandatory, while an `lsof` PID is
  validated when available instead of becoming load-sensitive under the full
  parallel suite.

### Foundations, measurement, and trust

- Brought bundled blueprint sources into the enforced coverage/reachability
  system and added behavioral CRUD proof for every declared handler. Web and
  native call sites are checked independently; the only accepted exceptions
  are named agent-only, extension-only, or platform-fallback capabilities with
  an explanatory rationale.
- Added the mobile protocol/capability handshake before replica mount. Old
  gateways and old apps now stop at one C1 update wall rather than attempting
  historical route shapes.
- Replaced Locker's permissive shell with vault-key-peppered, scrypt-hardened
  credentials, memory-only inactivity sessions, one-shot item reveal permits,
  background/timeout locking, clipboard clearing, and secret-free
  list/search/receipt surfaces. Native Locker remains online-only for
  authentication/reveal and never persists a credential or secret in the
  replica/outbox.
- Added an optional biometric whole-app gate that clears hydrated gateway
  credentials, unmounts the replica, and masks the switcher when backgrounded.
- Added durable revision/trash/restore/undo contracts and reachable,
  informative destructive flows for Notes, Docs, People, Tally, and Photos.
- Applied the shared adversarial rendering corpus to all eight real render
  paths and added fail-before-publish validation for malformed encodings,
  hostile CSV/ICS/vCard, unsafe ZIPs, and archive-bomb declarations.
- Added the shared time-engine package to the repository's type-aware lint
  manifest in `scripts/lint-types.sh`, so recurrence code cannot bypass that
  package-by-package gate.
- Closed the schema guardrails exercised by the final full-coverage gate:
  `packages/gateway/src/serve/gateway-db.test.ts` accounts for the durable
  sharing receipt table, time/organization foreign-key child columns are
  indexed, recurrence exceptions have a purge policy in the polymorphic
  registry, the exhausted-recurrence regression uses a deterministic
  timezone-work bound instead of wall-clock speed, and
  `packages/client/src/react/shell/App.inline-branch.test.tsx` retains a
  bounded first-load budget with headroom for the six-package gate.

### Honest daily-driver surfaces

- Native queries no longer turn a missing session into empty rows. Covers and
  Photos sub-screens expose loading, empty, offline, denied, and error states;
  queued writes are distinct from parked approvals; stable intent IDs,
  optimistic validation, refresh, and last-sync state are visible.
- Web blueprints gained cold-read skeletons, actionable empty/denied states,
  persistent connectivity/sync state, and a real search/no-results route.
- Added one universal capture plane across PWA/iOS/Android for text, URLs,
  files, camera OCR, and reviewed routing to task, expense, note, event, Docs,
  Photos, Locker, or canonical itemized Tally receipt.
- Added gateway-driven reminder/push registration, revocation, opaque wake
  payloads, consent-rechecked deep links, and complete/snooze/open/settle
  actions. Photos backup now exposes source album, network/roaming, battery,
  custody, background, and PWA bulk-import behavior.

### Time, organization, and interoperability

- Introduced one dependency-free zoned/floating/all-day recurrence core for
  Agenda, Tasks, Tally, automations, blueprint handlers, and mobile replica
  expansion. It owns DST gap/overlap behavior, original-occurrence identity,
  overrides/skips, completion-relative recurrence, end conditions, and
  readable previews.
- Completed Agenda editing and recurrence scopes; Tasks projects/areas,
  sections, ordering, and standard views; People contact channels,
  provenance/deduplication/merge undo; and Tally fixed-point multi-currency,
  rates, recurring expenses, and auditable history on web and native.
- Added one staged import framework with dry run/mapping/validation/conflicts,
  round trips for ICS/vCard/CSV/Markdown, and an integrity-manifest full export
  containing documents, immutable versions, notes, collections, tags, blobs,
  and hashes. Docs native file lifecycle and device adapters are reachable.
- Added Google Calendar and Contacts incremental writeback with field
  provenance, conditional writes, deterministic conflict records, and
  approved-outbox survival across OAuth revoke/reconnect.

### Compound, accessible, and shippable

- Added one FTS5 omnibox across all eight blueprints on web and mobile,
  including visible app filters and Unicode-preserving results. Notes uses
  portable CommonMark source, temporal `core.link` wikilinks to any non-secret
  entity, backlinks, and readable broken-link handling on both surfaces.
- Extended placement sharing to Photos albums, Docs, complete Tally groups,
  and Locker family items. Tally accounting parties remain distinct from
  authenticated household members. Locker cells are unsealed at the trusted
  local gateway and re-sealed under the audience vault's independent key/AAD;
  provider bindings are stripped. Share/unshare access receipts survive member
  revocation, while explicit unshare removes the independent projection.
- Added a bounded Daily Brief projection and Home cards for today's events,
  due tasks, new photos, and Tally balance. Mobile schedules an opaque morning
  notification only when notification permission is already granted.
- Exposed a cloneable cross-app automation gallery in the native product.
- Repaired live regions, focus-visible styles, modal focus trap/restore,
  danger-dialog keyboard behavior, keyboard shortcuts, Photos lightbox focus,
  native labels/roles/states, Dynamic Type, bounded image caches, and
  virtualization of the specified long lists. The accessibility dimension is
  now a continuously validated matrix lane.
- Added the 10k-photo / 5k-contact / three-calendar-year / 1k-note fixture with
  seed/read budgets. Device `ENOSPC`/`SQLITE_FULL` and gateway WAL-checkpoint
  failures pause safely without deleting replica rows or queued writes.
- Added App Store/Play release metadata and a reviewer checklist for privacy
  labels, permissions, background modes, export compliance, and accessibility;
  reviewed native fingerprints pin the resulting iOS/Android state.
- Added a real ACP subprocess parity test that crosses loopback MCP and invokes
  representative commands for all eight apps, asserting executed and parked
  consent outcomes, tool events, and receipt propagation.

## Decisions

- Formula-prefixed values in display-bearing CSV fields are rejected rather
  than silently rewritten. Secret/password cells remain arbitrary byte data.
- Unknown cellular roaming is treated as roaming and blocked unless the owner
  opts in; this is the privacy/cost-safe interpretation.
- Push endpoint tokens and the VAPID private key are revocable gateway/device
  capabilities, not portable vault records. Reminder definitions remain
  backup-covered user data.
- A moved recurring instance keeps its original occurrence instant as the
  durable identity. In a fall-back overlap the earlier instant wins and the
  duplicate wall occurrence is suppressed.
- CommonMark source is normalized only from CRLF to LF. Wikilink graph rows are
  derived metadata and never require a proprietary editor AST.
- “Tally members become authenticated household participants” is implemented
  as a member role on the audience vault. Accounting `core_party` rows never
  grant gateway authority.
- Household Locker sharing re-encrypts into the audience vault rather than
  sharing ciphertext or introducing a household-wide decryption key.
- Expo prebuild would replace the repository's hand-maintained native modules.
  The generated churn was discarded after review; only the intended config,
  matching iOS metadata, and regenerated fingerprints were retained.
- `expo install --check` remains the repository's documented advisory lane:
  the CI job is explicitly `continue-on-error`, and this issue does not perform
  an unrelated Expo dependency migration. Native-state, dual-platform Metro
  export, Xcode-floor, and Android Kotlin compilation are the blocking gates.
- Exact-HEAD mobile evidence is a release gate rather than a documented
  boundary: the branch is published and the `mobile-e2e-ios` workflow is run
  against the final commit before the receipt can pass audit.

## Out of scope

No scope was moved out of the issue. The issue's original exclusions remain:
external/public identities and links; recovery-kit emergency/digital-legacy
design; PWA autofill/passkey-provider behavior; mobile credential-provider
extensions; Microsoft/CardDAV consumers; proprietary Evernote/Notion/Apple
Notes importers beyond Markdown; heavy gateway ML beyond local OCR; replacing
the canonical gateway writer or adding multi-master vault state; provider SDKs
inside blueprint handlers; and pixel-identical cross-platform layouts.

## Verification

```sh
bun run typecheck
bun run test:matrix
bun run lint:e2e-flows
bun run test:accessibility
bun run test:scale
bun run --cwd apps/mobile ci:native-state
bun run --cwd apps/mobile ci:bundle
bun run --cwd apps/mobile ci:android-native
bun run check:pr:full
```

- `bun run typecheck` — 34/34 workspace tasks.
- `bun run test:matrix` — 15 surfaces × 11 dimensions, 59 canonical flows;
  blueprint and native capability rows have no `gap`/`skip`.
- `bun run lint:e2e-flows` — 54 non-vacuous Maestro steps across four flows.
- `bun run test:accessibility` — 4/4 contracts.
- `bun run test:scale` — 13/13 fixtures, including the issue #630 large vault.
- `bun run --cwd apps/mobile ci:native-state` — Pod lock, project paths, and
  both reviewed fingerprints agree.
- `bun run --cwd apps/mobile ci:bundle` — iOS and Android production bundles.
- `bun run --cwd apps/mobile ci:android-native` — 459 tasks, Kotlin compile
  successful.
- Focused protocol/gateway/client/mobile Wave 6 suites — 47 tests passing.
- Focused household placement/custody suites — 6 tests passing.
- Focused blueprint boot, reachability, state-honesty, untrusted rendering,
  and behavioral CRUD suites — 299 tests passing.
- ACP → MCP blueprint agent parity integration — passing for all eight apps.
- `bun run check:pr:full` — green: all static, affected/full test, and
  diff-coverage gates; 781 coverage test files, 6,341 passing tests, and 84.9%
  changed-line coverage against the 80% floor.
- Fresh-context audit — pending final re-audit below.

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

<!-- Checkpoint: Wave 5 uses one fail-before-publish staging contract for ICS,
vCard, CSV, Markdown directories, and the integrity-checked full export ZIP.
The export includes documents, immutable versions, notes, collections, tags,
canonical content hashes, and a verification manifest; onboarding exposes a
dry run and mapping preview before canonical publication. PWA directory
selection uses File System Access when available and a multi-file fallback
otherwise. Expo Docs uses the OS document provider and the durable background
upload queue, with OS sharing as the device-file export adapter; rename, move,
folder delete, trash, and restore are now reachable on mobile.

Google Calendar and Contacts now use one provider-writeback contract with
incremental cursors, entity/field provenance, conditional writes, deterministic
conflict records, and approved outbox survival across revoke/reconnect. The
shared Assist client requests the write scopes already selected in Wave 0; BYO
clients remain available. Synthetic end-to-end coverage proves local edit →
provider PATCH, a 403 authorization loss, token replacement, and replay.

Wave 6's first compound surface also lands here because it shares the same
portable data boundary: one FTS5 omnibox fans out across all eight blueprints
on web and mobile with visible app filters and Unicode-preserving results.
Notes is now a first-class native cover. Both editors preserve plain
CommonMark source; reviewed `[[wikilinks]]` compile separately to temporal
`core.link` rows and text anchors, support any non-secret blueprint entity,
render backlinks, and leave unresolved links as readable, actionable text.

Ambiguity decision: Markdown is normalized only from CRLF to LF. Centraid does
not serialize a proprietary editor AST into the body, so round trips remain
portable and wikilink graph metadata can be rebuilt or discarded without
rewriting authored text. Google conflicts are persisted instead of applying a
last-writer-wins guess. -->

<!-- Checkpoint: P8 now uses the #599 placement boundary for whole photo
albums, Docs, Tally groups, and Locker family items on web and native. Tally
projects its complete accounting closure while keeping `core_party`
participants categorically separate from authenticated gateway members.
Locker never copies sealed ciphertext across vaults: the L0-trusted local
gateway unseals the selected cells and re-seals them under the audience
vault's independent DEK/AAD, strips provider connection bindings, and never
puts secret values in the durable access receipt. Placement link tokens make
offline replay exactly-once; share and unshare receipts survive member-role
revocation, which removes authority and the native replica scope without
destroying the audience copy for remaining members.

Ambiguity decision: “Tally members become authenticated household
participants” means a gateway member must hold a role in the audience vault
containing the placed group. It does not create a forbidden
gateway-member→core-party pointer or make an expense participant an
authorization principal. Revocation removes the role; deleting the shared
projection is a separate explicit unshare operation. -->

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
| codex-019fad18-4c1-1785343725-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 801482 | 0 | 31281664 | 101002 | 902484 | 11.3392 | 5768722 | 0 | 294848768 | 839971 | feat(interop): add portable sync and linked search (#630) |
| codex-019fad18-4c1-1785344044-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 45581 | 0 | 2689024 | 7155 | 52736 | 0.8935 | 5814303 | 0 | 297537792 | 847126 | feat(interop): add portable sync and linked search (#630) |
| codex-019fad18-4c1-1785348086-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 1231166 | 0 | 42480384 | 123898 | 1355064 | 15.5565 | 7045469 | 0 | 340018176 | 971024 | feat(readiness): complete compound and polish surfaces (#630) |
| codex-019fad18-4c1-1785350971-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 660698 | 0 | 16481536 | 37691 | 698389 | 6.3375 | 7706167 | 0 | 356499712 | 1008715 | feat(readiness): complete compound and polish surfaces (#630) |
| codex-019fad18-4c1-1785351038-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 2243 | 0 | 196096 | 115 | 2358 | 0.0564 | 7708410 | 0 | 356695808 | 1008830 | feat(readiness): complete compound and polish surfaces (#630) -m governance: all |
| codex-019fad18-4c1-1785351250-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 32662 | 0 | 1772544 | 5205 | 37867 | 0.6029 | 7741072 | 0 | 358468352 | 1014035 | merge: reconcile onboarding mainline (#630) |
| codex-019fad18-4c1-1785351313-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 14266 | 0 | 514048 | 1081 | 15347 | 0.1804 | 7755338 | 0 | 358982400 | 1015116 | merge: reconcile onboarding mainline (#630) |
| codex-019fad18-4c1-1785351530-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 54696 | 0 | 2960896 | 4566 | 59262 | 0.9455 | 7810034 | 0 | 361943296 | 1019682 | fix(ui): preserve token ratchet after mainline merge (#630) |
| codex-019fad18-4c1-1785351624-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 6744 | 0 | 1069568 | 1567 | 8311 | 0.3078 | 7816778 | 0 | 363012864 | 1021249 | fix(ui): preserve token ratchet after mainline merge (#630) |
| codex-019fad18-4c1-1785352090-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 78506 | 0 | 2589440 | 2739 | 81245 | 0.8847 | 7895284 | 0 | 365602304 | 1023988 | test(gateway): make lock PID enrichment load-safe (#630) |
| codex-019fad18-4c1-1785352146-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 3175 | 0 | 125952 | 557 | 3732 | 0.0478 | 7898459 | 0 | 365728256 | 1024545 | test(gateway): make lock PID enrichment load-safe (#630) |
| codex-019fad18-4c1-1785352224-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 18562 | 0 | 198144 | 805 | 19367 | 0.1080 | 7917021 | 0 | 365926400 | 1025350 | test(gateway): narrow optional lock diagnostics (#630) |

## Steering

- PASS — The supplied session transcript contains one initial human task request
  and no later human interrupt or correction. It contains no tool-denial event
  to record. Therefore no steering-ledger rows are warranted.

## Audit

- REFUTED — `## What changed` now names the time-engine lint target and final
  schema/gate corrections, but it does not describe the full current diff. In
  particular, the diff deletes #634's receipt and its Settings/profile/pairing
  surfaces (`receipts/issue-634-onboarding-identity-pairing.md`,
  `SettingsDeviceScreen.tsx`, `SettingsProfileScreen.tsx`, and
  `PairDeviceModal.tsx`) without a corresponding #630 narrative.
- REFUTED — W0.7 is checked but its required exact-HEAD iOS nightly proof is
  absent. The receipt states the branch was not pushed; `git ls-remote` finds
  no branch and `gh run list --branch codex/issue-630-blueprint-readiness`
  returns no runs for HEAD `8c510b21a0d3f00e655fb2d4770dad3b398e2ce3`.
  The passed local `check:pr:full` gate cannot establish that remote exit
  criterion.
- REFUTED — Although the 93 W0.1–W6.16/E1–E5 identifiers now crosswalk to the
  issue, the checklist does not faithfully mirror W0.7: issue #630 requires
  proving `mobile-e2e-ios` green at HEAD, whereas the receipt substitutes
  “carry the exact-HEAD iOS evidence boundary honestly.” The issue's seven
  exit-gate demonstrations likewise remain required evidence, not a weaker
  documentation boundary.
