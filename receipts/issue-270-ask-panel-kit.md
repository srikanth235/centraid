# issue-270 — Wire the Ask-your-vault panel + centralize the blueprint kit

GitHub issue: [#270](https://github.com/srikanth235/centraid/issues/270)

The 14 blueprint apps carried an "Ask your vault" affordance whose button did
nothing, and the shared kit (`kit.js` / `kit.css`) was duplicated as a per-app
copy in all 14 folders. This change lands an uploaded visual redesign, collapses
the kit to a single canonical copy the runtime serves, and wires the panel to the
real vault surfaces that already exist — the per-app `_turn` conversation agent
and the vault plane's parked-approval routes — so every write is proposed for the
owner's consent and no reply is fabricated. v0, pre-release: no
backward-compatibility or migration constraints apply.

## Checklist

- [x] Apply the uploaded visual redesign to all 14 blueprint apps (app.css + index.html Ask-panel mount and KIT_ASK config), mobile unchanged
- [x] Fold the Ask controller into kit.js and serve one canonical kit.js/kit.css via app-engine sharedAssetsDir wired to blueprints KIT_DIR; drop per-app copies and sync-kit.mjs
- [x] Wire the Ask panel to real vault surfaces: _turn agent SSE stream, parked-approval confirm/deny, live grant chip
- [x] Keep all panel states (consent, notice, parked, empty, loading) rendering in light and dark with no console errors

## What changed

### Apply the uploaded visual redesign to all 14 blueprint apps (app.css + index.html Ask-panel mount and KIT_ASK config), mobile unchanged

Every app got its redesigned drop-in `app.css` and two `index.html` edits — a
`data-ask-mount` attribute on the header (or `.head-tools` / `.head-actions`
per app) and an inline `window.KIT_ASK` config block before `app.js`. The
existing Centraid settings-bridge `<script>` and the mobile layout are
untouched. Files, per app:

- `packages/blueprints/apps/agenda/app.css`, `packages/blueprints/apps/agenda/index.html`
- `packages/blueprints/apps/bookings/app.css`, `packages/blueprints/apps/bookings/index.html`
- `packages/blueprints/apps/budgets/app.css`, `packages/blueprints/apps/budgets/index.html`
- `packages/blueprints/apps/docs/app.css`, `packages/blueprints/apps/docs/index.html`
- `packages/blueprints/apps/home-inventory/app.css`, `packages/blueprints/apps/home-inventory/index.html`
- `packages/blueprints/apps/leads/app.css`, `packages/blueprints/apps/leads/index.html`
- `packages/blueprints/apps/notes/app.css`, `packages/blueprints/apps/notes/index.html`
- `packages/blueprints/apps/people/app.css`, `packages/blueprints/apps/people/index.html`
- `packages/blueprints/apps/photos/app.css`, `packages/blueprints/apps/photos/index.html`
- `packages/blueprints/apps/studio/app.css`, `packages/blueprints/apps/studio/index.html`
- `packages/blueprints/apps/subscriptions/app.css`, `packages/blueprints/apps/subscriptions/index.html`
- `packages/blueprints/apps/tasks/app.css`, `packages/blueprints/apps/tasks/index.html`
- `packages/blueprints/apps/threads/app.css`, `packages/blueprints/apps/threads/index.html`
- `packages/blueprints/apps/vitals/app.css`, `packages/blueprints/apps/vitals/index.html`

### Fold the Ask controller into kit.js and serve one canonical kit.js/kit.css via app-engine sharedAssetsDir wired to blueprints KIT_DIR; drop per-app copies and sync-kit.mjs

- `packages/blueprints/kit/kit.js` — the former standalone `kit-ask.js`
  controller IIFE is folded in (runs at module-eval when `app.js` does
  `import './kit.js'`); carries a head-of-file file-size-limit waiver.
- `packages/blueprints/kit/kit.css` — Ask-panel primitives (busy/note states
  for the approval card).
- `packages/app-engine/src/http/static-server.ts` — `serveStatic` gains a
  `sharedAssetsDir` fallback: a whitelisted `kit.js` / `kit.css` an app folder
  doesn't ship is served from the shared dir (the app's own copy still wins).
- `packages/app-engine/src/http/static-server.test.ts` — four tests for the
  fallback (shared serve, per-app override, no-dir 404, non-whitelisted 404).
- `packages/app-engine/src/runtime.ts` — `RuntimeOptions.sharedAssetsDir`
  threaded into the app-static serve calls.
- `packages/blueprints/src/index.ts` — new `KIT_DIR` export (the canonical
  shared dir).
- `packages/gateway/src/serve/build-gateway.ts` — passes `KIT_DIR` as the
  runtime's `sharedAssetsDir`.
- `packages/blueprints/package.json` — adds `kit` to published `files`.
- `packages/blueprints/manifest.json` — regenerated; `kit.js` / `kit.css` no
  longer listed under any app's files.
- `packages/blueprints/src/scaffold-defaults.ts` — scaffold guidance updated:
  reference the kit, never copy it into the app folder.
- The 28 per-app `kit.js` / `kit.css` copies and `packages/blueprints/scripts/sync-kit.mjs`
  are deleted (the sync script's only job was fanning those copies out).

### Wire the Ask panel to real vault surfaces: _turn agent SSE stream, parked-approval confirm/deny, live grant chip

In `packages/blueprints/kit/kit.js`, a default driver (`makeVaultDriver`,
installed unless an app calls `kitAsk.onAsk`):

- POSTs `{conversationId, message}` to the app's `_turn` route and stream-parses
  the SSE `TurnStreamEvent` frames (assistant deltas stream into the bubble).
- A `tool.result` carrying `{status:'parked', invocationId}` is looked up on
  `GET /centraid/_vault/parked` and rendered as a proposed-write card; Approve
  and Discard POST `/centraid/_vault/parked/<id>` `{approve}` and render the real
  `InvokeOutcome` (receipt id on `executed`, the vault's reason on refusal).
- The context chip (`[data-kit-grant]`) refreshes on first open from
  `/centraid/_vault/status` + `/centraid/_vault/apps` with the app's real grant
  verbs; unreachable → the default label stays.
- `propose()` is now async-aware (`{ok, receipt|note}`), and the dead Edit button
  only renders when an `onEdit` handler is supplied.
- `packages/blueprints/apps/tasks/index.html` — its KIT_ASK comment updated to
  describe the default `_turn` driver.

### Keep all panel states (consent, notice, parked, empty, loading) rendering in light and dark with no console errors

`packages/blueprints/kit/kit.css` adds `.aa-busy` (decision in flight) and
`.aa-note` (a shown refusal/failure) so the approval card has honest busy and
error states alongside the existing consent/notice/parked/empty/loading styles.

## Out of scope

- Auto-refreshing an app's projection after an approved write: only `docs`
  subscribes to the change bus today; the other 13 apps won't repaint until their
  `app.js` opts into `window.centraid.onChange`. Tracked as a follow-up.
- `wall.css` remains a per-app copy — only `kit.js` / `kit.css` were centralized,
  as scoped.
- No handler / action / query / app.json changes; app behavior and data are
  untouched. `packages/app-blueprints.zip` and `packages/blueprints/apps.zip` are
  stale untracked build bundles, left as-is.

## Decisions

- **Central serving over gitignore+generate.** A single physical copy served by
  the runtime (not 14 generated copies) is the only thing that removes the
  duplication at runtime too; the app-engine `sharedAssetsDir` fallback keeps a
  per-app override possible, so it is additive, not a breaking removal.
- **Default driver in the kit, not per-app `app.js`.** All apps share one
  `_turn` + parked-approval contract, so wiring lives once in `kit.js`; an app
  can still override via `kitAsk.onAsk`. This supersedes an earlier plan (and a
  spawned background task) to wire each `app.js` separately.
- **Folded `kit-ask.js` into `kit.js`** rather than shipping a second synced
  file — it rides the ES-module `import './kit.js'` every app already does, so
  no new `<script>` tag or manifest entry.
- **`kit.js` over the 500-line cap** by design (single canonical bundle served as
  one request); head-of-file waiver records the rationale.

## Verification

```bash
# typecheck + unit suites across the three touched packages
bunx turbo run typecheck test \
  --filter=@centraid/app-engine --filter=@centraid/blueprints --filter=@centraid/gateway
# → app-engine 318+4 tests, gateway 139, blueprints green; typecheck clean

# lint + format on the change set
git diff --name-only | xargs bunx oxfmt --check
bunx oxlint packages/blueprints/kit/kit.js

# kit.js is still a valid ES module after the fold + waiver
node --check --input-type=module < packages/blueprints/kit/kit.js
```

End-to-end serving proof — the real (now kit-less) `leads` app folder serves the
canonical folded `kit.js` / `kit.css` from `KIT_DIR` via the fallback (matches
byte-for-byte; 404s without the shared dir).

Browser proof against a protocol-faithful gateway double (real tasks app + real
kit): grant chip populated from `/_vault/apps` grants; `_turn` reply streamed;
parked card → Approve → `approved · receipt rcpt_91` with the server recording
`{approve:true}`; Discard recording `{approve:false}`; `no_conversation_runner`
503 → honest "open Settings → Agents" message; zero console errors in light and
dark at 375px and ≥720px.

## Steering

| check | verdict | evidence |
| --- | --- | --- |
| steering events recorded | PASS | Interrupts/corrections drove the design: (1) "reuse it" / "still present across 14 apps" corrected an incomplete dedup into the canonical-kit approach; (2) "can't we just fold kit-ask.js into kit.js?" redirected the second synced file into the module fold; (3) interrupt "remember this is v0" removed the backward-compat framing from the central-serving design; (4) interrupt redirect "work on proper wiring of consent grants into chat widget" scoped the wiring to the real `_turn` + parked surfaces. |
| no non-steering recorded | PASS | Initial task ("apply the redesign") and continuation asks ("remove preview.html", "delete uploads dir", "create a PR") are task definition/continuation, not redirects. |

## Audit

- Verdict: PASS
- Check 1 (what-changed fidelity): PASS — the staged diff matches every claim: `KIT_DIR` export, gateway `sharedAssetsDir: KIT_DIR`, runtime + `static-server` fallback with `SHARED_ASSET_FILES` whitelist and 4 new tests, folded Ask controller + `makeVaultDriver` in `kit.js`, `.aa-busy`/`.aa-note` in `kit.css`, 28 per-app copies + `sync-kit.mjs` deleted, and manifest/package.json/scaffold updated.
- Check 2 (checklist items realized in diff): PASS — all 14 apps carry `data-ask-mount` + `window.KIT_ASK` in staged `index.html`, the canonical kit is served via `sharedAssetsDir`/`KIT_DIR` with per-app copies dropped, and the driver wires `_turn` SSE + `/centraid/_vault/parked` approve/deny + a `[data-kit-grant]` chip from `/_vault/status`+`/_vault/apps`.
- Check 3 (checklist mirrors issue): PASS — the receipt's four `## Checklist` items are textually identical to issue #270's four checklist items.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-1ba98bfa-b70-1783154043-1 | claude-code | 1ba98bfa-b700-4bca-918d-ec8825ddddae | #270 | claude-opus-4-8 | 89126 | 4728730 | 95301823 | 609590 | 5427446 | 92.8909 | 89126 | 4728730 | 95301823 | 609590 |  |
