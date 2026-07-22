# Issue #505 — inline system apps, iframe reserved for builder, app-scoped RPC, token-plane retirement

## Checklist

- [ ] Phase 0: baseline cold+warm bundled-app open recorded; go/no-go noted
- [ ] Phase 1: CSS scoping for all 8 blueprint apps; typed app-kind signal in the render path; written surface inventory in docs/refactors/inline-system-apps.md
- [ ] Phase 2: shell app services (queries/actions via replica intent dispatch with intentId, change subscriptions, consent, settings, chat wiring)
- [ ] Phase 3: Tasks inline pilot (lazy chunk, error boundary, sync theming, offline render)
- [ ] Phase 4: remaining seven apps inline; bundled path removed from AppFrame; opaque path byte-for-byte builder-only
- [ ] Phase 5: /centraid/_tool/centraid_* removed; app-scoped routes; Companion + builder bridge re-pointed
- [ ] Phase 6: centraid_sql_* ghosts deleted; ARCHITECTURE.md / blueprint-csp trap / protocol docs updated
- [ ] Phase 7: token landlord plane retired (owner enrollment tier, token.bin/print-token deleted, direct-tier decision recorded, revocation severs all planes)
- [ ] check:pr green at each phase boundary

## Phase 0 — baseline measurement (2026-07-22)

Method: no remote gateway is reachable from this session, so the baseline combines
(a) the existing #404 PWA waterfall harness (Playwright, loopback gateway, real
installed-app open, cold + warm), and (b) a direct request-chain trace of the real
installed **Tasks** bundled app against a live harness gateway, with remote cost
modeled from measured request counts/bytes × RTT. Caveat: RTT figures are modeled,
not measured over a WAN.

Measured (loopback, this tree):

- Harness app open (PWA shell → installed app iframe): cold 1303 ms / warm 1283 ms
  elapsed (both include the spec's fixed 1200 ms settle wait → ~100 ms actual);
  **warm/cold transfer ratio 1.0** — the app document is re-fetched in full on every
  open.
- Real bundled app (Tasks, installed): open = **2 requests, 571,605 bytes** —
  the baked HTML document (109,440 B, **`Cache-Control: no-store`**) + the prebuilt
  `_bundle.<hash>.js` (462,563 B, `private, max-age=31536000, immutable`).
- Waterfall depth: 2 sequential levels (document → bundle), then data queries +
  `/_changes` SSE after mount (≥1 further sequential round before content).

Modeled remote-tunnel cost (measured sizes × RTT; 5 Mbps assumed for transfer):

- **Warm open** (bundle cached, document `no-store` so always re-fetched):
  ≈ 1 RTT + 109 KB ≈ **0.33 s at 50 ms RTT / 0.6 s at 150 ms RTT**, every open, forever —
  the `no-store` document is a floor no cache can remove.
- **Cold open**: adds the 462 KB bundle ≈ **1.1 s (50 ms) / 1.5 s (150 ms)** before
  first paint, plus the post-mount data round.
- **Offline: nothing renders** — the document is assembled live from the gateway.

Go/no-go: **GO.** The #404 bundling work already collapsed the asset waterfall
(2 requests), so the residual cost is structural, not fixable by more caching:
every open pays ≥1 tunnel round trip + 109 KB for a document the shell could render
from its own bundle, and offline render is impossible on this path. The
robustness case (blank-pane failure class, error boundaries, one React runtime)
stands independently. Baseline numbers to beat: warm open tunnel requests 2 → 0;
offline render none → full.

## What changed

- **Phase 6 (ghost cleanup, landed early as an independent slice)**: deleted every
  `centraid_sql_*` reference from `packages/` sources — stale comments in
  `packages/app-engine/src/conversation/turn.ts` (ToolContext now names the real
  `vault_sql`/`vault_invoke` tools), `packages/app-engine/src/conversation/runner.ts`,
  `packages/app-engine/src/stores/gateway-db.ts`,
  `packages/app-engine/src/conversation/store.ts`, and the fixture tool names in
  `packages/app-engine/src/conversation/history.test.ts` (`centraid_sql_read` →
  `vault_sql`, `centraid_sql_write` → `vault_invoke`). Docs write-back for Phase 6
  lands with the end state.
- **Phase 1 (surface inventory)**: written into
  `docs/refactors/inline-system-apps.md` — every app-consumed router surface mapped
  to its shell-native replacement; settles issue open questions 2 (chat is
  universal, 8/8 apps) and 3 (query bundles redundant inline).

## Out of scope

- Agent vault tools (vault_sql / vault_invoke / vault_content) and the ACP/MCP surface
- Builder feature work; the opaque-document machinery internals
- Gateway HTTP serving of apps (mobile WebViews + builder preview)
- Mobile client changes
- 2026-07-18 onboarding blockers (issue #505 recommends they land first; noted below under decisions)

## Decisions made without user input (orchestrator recommendations)

- **Phase 0 method**: the issue asks for timings "over a real remote tunnel". No remote
  gateway is reachable from this autonomous session, so the baseline uses the existing
  #404 PWA waterfall harness (loopback gateway, real installed-app open, cold+warm) for
  measured request counts/bytes/elapsed, and models the remote cost as
  measured-sequential-request-count × RTT (50 ms and 150 ms points). Honest caveat
  recorded with the numbers.
- **Open question 4 (ordering vs onboarding blockers)**: proceeding with #505 now, as
  directed by the session goal; the onboarding blockers remain separate work.
- **CSS scoping timing (Phase 1)**: taken per-app during conversion (the issue allows
  either). Rationale: `app.css`/`wall.css` style the static `index.html` chrome; that
  chrome becomes React components during inline conversion, which is exactly when its
  selectors are rewritten as CSS modules — a preceding sweep would rewrite the same
  selectors twice. Component-level CSS modules already exist in all 8 apps.
- **Open question 2 (embedded chat)**: answered by inventory — all 8 apps embed the kit
  ask panel; the inline equivalent is one shared shell service, not per-app work.
- **Open question 3 (`_query/<name>.mjs` bundles)**: redundant inline — query modules are
  relative-import-only and confined to `queries/`, so the shell imports them directly;
  the network bundle survives for the served (WebView/builder) path.
- **Open question 5 (`direct` transport tier)**: KEEP as an escape hatch for self-fronted
  TLS (Tailscale/Caddy/Cloudflare), on per-device HTTP tokens only. Killing it would also
  amputate the PWA's direct-URL pairing path (`web-host.ts` pairs over HTTP with a device
  token), which is a bigger product decision than #505 needs; the shared admin token dies
  either way. To be recorded in docs/decisions.md in Phase 7.
- **Open question 6 (CLI-admin loopback)**: recon settled this — the admin CLI never
  authenticates to the daemon over HTTP; every admin command operates directly on the
  data-dir files (locks + mtime reload), so deleting `token.bin` needs no CLI
  replacement mechanism. Only `print-token` dies with it. Trust anchor remains OS
  filesystem access to `--data-dir`, documented in SECURITY.md.

## Verification

Phase 0 baseline (re-runnable):

```sh
# Boot the harness gateway, install Tasks, trace its open waterfall:
node --experimental-strip-types apps/web/tests/e2e/server.ts &
curl -s -X POST http://127.0.0.1:48765/centraid/_apps/_install \
  -H "Authorization: Bearer centraid-web-e2e-token" \
  -H "content-type: application/json" -d '{"templateId":"tasks"}'
# then: fetch /centraid/tasks/ and its referenced _bundle.<hash>.js, observe
# 2 requests / ~572 KB, document Cache-Control: no-store, bundle immutable.

# Playwright cold/warm app-open waterfall (writes test-results/perf-waterfall-report.json):
bun run build
cd apps/web && npx playwright test -c tests/e2e/playwright.config.ts -g "app-open waterfall"
```

Later phases append their own commands here as they land.

## Steering

- Check 1 (all steering events recorded): PASS — Transcript contains zero human steering events; only initial `/goal` command remains.
- Check 2 (no non-steering recorded as steering): PASS — No Steering table rows exist, nothing misrecorded.

## Audit

- Check 1 (faithful description of diff): PASS — 'What changed' describes Phase 6 ghost cleanup (5 files) and Phase 1 surface inventory; diff verifies both: centraid_sql_* references deleted, router surface inventory table filled with all mappings.
- Check 2 (checked items realized in diff): PASS — All 9 checklist items remain unchecked; Phase 0 and Phase 1 work complete but correctly not claimed [x].
- Check 3 (checklist mirrors structure): PASS — Receipt checklist (Phases 0–7 plus "check:pr green") mirrors issue acceptance criteria by phase gates.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-3f73ae52-798-1784718955-1 | claude-code | 3f73ae52-798f-419a-bac9-2e6ed4a21184 | #505 | claude-fable-5 | 187 | 348147 | 9599160 | 86271 | 434605 | 18.2664 | 187 | 348147 | 9599160 | 86271 | docs(refactors): open #505 plan log and phase-0 baseline receipt (#505)Phase 0 g |
| claude-code-3f73ae52-798-1784719281-1 | claude-code | 3f73ae52-798f-419a-bac9-2e6ed4a21184 | #505 | claude-fable-5 | 10 | 48619 | 722461 | 6738 | 55367 | 1.6672 | 197 | 396766 | 10321621 | 93009 | docs(refactors): open #505 plan log and phase-0 baseline receipt (#505)Phase 0 g |
| claude-code-3f73ae52-798-1784719320-1 | claude-code | 3f73ae52-798f-419a-bac9-2e6ed4a21184 | #505 | claude-fable-5 | 2 | 394 | 156769 | 165 | 561 | 0.1700 | 199 | 397160 | 10478390 | 93174 | docs(refactors): open #505 plan log and phase-0 baseline receipt (#505)Co-Author |
| claude-code-3f73ae52-798-1784719431-1 | claude-code | 3f73ae52-798f-419a-bac9-2e6ed4a21184 | #505 | claude-fable-5 | 32 | 37471 | 2594195 | 8407 | 45910 | 3.4833 | 231 | 434631 | 13072585 | 101581 | docs(refactors): open #505 plan log and phase-0 baseline receipt (#505)Phase 0 g |
| claude-code-3f73ae52-798-1784719828-1 | claude-code | 3f73ae52-798f-419a-bac9-2e6ed4a21184 | #505 | claude-fable-5 | 92 | 77019 | 8581250 | 58863 | 135974 | 12.4881 | 323 | 511650 | 21653835 | 160444 | chore(app-engine): delete centraid_sql_* ghosts; record #505 surface inventory ( |
| claude-code-3f73ae52-798-1784719879-1 | claude-code | 3f73ae52-798f-419a-bac9-2e6ed4a21184 | #505 | claude-fable-5 | 2 | 1442 | 200189 | 182 | 1626 | 0.2273 | 325 | 513092 | 21854024 | 160626 | chore(app-engine): delete centraid_sql_* ghosts; record #505 surface inventory ( |
| claude-code-3f73ae52-798-1784719940-1 | claude-code | 3f73ae52-798f-419a-bac9-2e6ed4a21184 | #505 | claude-fable-5 | 8 | 6623 | 808412 | 2806 | 9437 | 1.0316 | 333 | 519715 | 22662436 | 163432 | chore(app-engine): delete centraid_sql_* ghosts; record #505 surface inventory ( |
