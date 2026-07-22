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
- **Phases 2+3 (shell services + Tasks inline pilot, one wave — knip would flag
  Phase-2 exports with no consumer)**:
  - Shell services in `packages/client/src/react/blueprints/`:
    `react-core-shim.ts` (single React runtime behind the vendored
    `./react-core.min.js` specifier), `kit-inline.ts` (kit API mirror — pure surface
    re-exported verbatim, data/gateway seams overridden), `centraid-inline.ts`
    (`window.centraid` on `ReplicaShellSession`; `intentId` rides writes verbatim),
    `inlineQueryCtx.ts` (bridge `runLocalQuery` reproduced; `ctx.vault.resolve` →
    `{cards:[]}`, never rejects), `kit-ask-inline.ts` (lazy online-only ask panel →
    gateway `_turn` + parked consent), `suppress-served-ask.ts`,
    `inline-vite-aliases.ts`, plus tsc stubs `inline-app-module-stub.d.ts` /
    `inline-query-stub.d.ts` and tests (`react-core-shim.test.ts`,
    `kit-inline.test.ts`, `centraid-inline.test.ts`, `inlineQueryCtx.test.ts`).
  - Tasks pilot in `packages/blueprints/apps/tasks/`: `app-inline.tsx`,
    `Chrome.tsx`, `Chrome.module.css` (served entry byte-for-byte untouched);
    shared contract `packages/blueprints/apps/inline-types.ts`;
    `packages/blueprints/manifest.json` regenerated for the three new files.
  - Route host: `packages/client/src/react/shell/routes/InlineAppRoute.tsx` +
    `InlineAppRoute.module.css` + `InlineAppRoute.test.tsx`, registry
    `packages/client/src/react/shell/routes/inlineApps.ts` (per-app `React.lazy`
    chunk), branch in `packages/client/src/react/shell/App.tsx` (+
    `App.inline-branch.test.tsx`), `packages/client/src/react/shell/ErrorBoundary.tsx`
    gains `onReset`, knob push branch in
    `packages/client/src/react/shell/routes/AppSettingsController.tsx` and
    `packages/client/src/react/shell/routes/appSettingsData.ts`.
  - Build wiring: `apps/web/vite.config.ts`, `apps/desktop/vite.config.ts`,
    `packages/client/vitest.config.ts`, `packages/client/tsconfig.json`,
    `apps/web/tsconfig.json`, `apps/desktop/tsconfig.react.json` (alias + stub
    paths), `apps/web/public/sw.js` (transitive lazy-chunk precache crawl so a
    never-opened app still opens offline).
  - Full file manifest of this wave:
    `packages/client/src/react/blueprints/react-core-shim.ts`,
    `packages/client/src/react/blueprints/react-core-shim.test.ts`,
    `packages/client/src/react/blueprints/kit-inline.ts`,
    `packages/client/src/react/blueprints/kit-inline.test.ts`,
    `packages/client/src/react/blueprints/centraid-inline.ts`,
    `packages/client/src/react/blueprints/centraid-inline.test.ts`,
    `packages/client/src/react/blueprints/inlineQueryCtx.ts`,
    `packages/client/src/react/blueprints/inlineQueryCtx.test.ts`,
    `packages/client/src/react/blueprints/kit-ask-inline.ts`,
    `packages/client/src/react/blueprints/suppress-served-ask.ts`,
    `packages/client/src/react/blueprints/inline-vite-aliases.ts`,
    `packages/client/src/react/blueprints/inline-app-module-stub.d.ts`,
    `packages/client/src/react/blueprints/inline-query-stub.d.ts`,
    `packages/blueprints/apps/inline-types.ts`,
    `packages/blueprints/apps/tasks/app-inline.tsx`,
    `packages/blueprints/apps/tasks/Chrome.tsx`,
    `packages/blueprints/apps/tasks/Chrome.module.css`,
    `packages/blueprints/manifest.json`,
    `packages/client/src/react/shell/routes/InlineAppRoute.tsx`,
    `packages/client/src/react/shell/routes/InlineAppRoute.module.css`,
    `packages/client/src/react/shell/routes/InlineAppRoute.test.tsx`,
    `packages/client/src/react/shell/routes/inlineApps.ts`,
    `packages/client/src/react/shell/App.tsx`,
    `packages/client/src/react/shell/App.inline-branch.test.tsx`,
    `packages/client/src/react/shell/ErrorBoundary.tsx`,
    `packages/client/src/react/shell/routes/AppSettingsController.tsx`,
    `packages/client/src/react/shell/routes/appSettingsData.ts`,
    `apps/web/vite.config.ts`, `apps/desktop/vite.config.ts`,
    `packages/client/vitest.config.ts`, `packages/client/tsconfig.json`,
    `apps/web/tsconfig.json`, `apps/desktop/tsconfig.react.json`,
    `apps/web/public/sw.js`.
  - Browser-verified in real Chromium against the harness gateway: zero iframes;
    app code served only from PWA-origin chunks (no `/centraid/tasks/*`, `_tool`,
    `_changes`, `_query` requests); capture write landed through the replica intent
    dispatch; gateway killed → Tasks still opens and renders live replica data.
    Three visual defects found in the first smoke (app sidebar overlaying shell
    sidebar from a collapsed flex root + phone-drawer fallback; blank white
    chips/buttons from a missing global `kit.css` import; Enter-submit appearing
    broken as a side effect) were fixed and re-verified with programmatic
    assertions.

- **Phase 4 (remaining seven apps inline)**: agenda, tally, people, notes, docs,
  locker, and photos each gained the co-located inline triple —
  `packages/blueprints/apps/agenda/app-inline.tsx`,
  `packages/blueprints/apps/agenda/Chrome.tsx`,
  `packages/blueprints/apps/agenda/Chrome.module.css`,
  `packages/blueprints/apps/tally/app-inline.tsx`,
  `packages/blueprints/apps/tally/Chrome.tsx`,
  `packages/blueprints/apps/tally/Chrome.module.css`,
  `packages/blueprints/apps/people/app-inline.tsx`,
  `packages/blueprints/apps/people/Chrome.tsx`,
  `packages/blueprints/apps/people/Chrome.module.css`,
  `packages/blueprints/apps/notes/app-inline.tsx`,
  `packages/blueprints/apps/notes/Chrome.tsx`,
  `packages/blueprints/apps/notes/Chrome.module.css`,
  `packages/blueprints/apps/docs/app-inline.tsx`,
  `packages/blueprints/apps/docs/Chrome.tsx`,
  `packages/blueprints/apps/docs/Chrome.module.css`,
  `packages/blueprints/apps/locker/app-inline.tsx`,
  `packages/blueprints/apps/locker/Chrome.tsx`,
  `packages/blueprints/apps/locker/Chrome.module.css`,
  `packages/blueprints/apps/photos/app-inline.tsx`,
  `packages/blueprints/apps/photos/Chrome.tsx`,
  `packages/blueprints/apps/photos/Chrome.module.css` — each a React chrome
  reproducing the app's static `index.html` shell as a CSS module (app-specific
  tokens folded onto the module root; shared token layer comes from the scoped
  block InlineAppRoute injects), with the served entry byte-for-byte untouched.
  Registry `packages/client/src/react/shell/routes/inlineApps.ts` now lists all
  8 apps as lazy chunks.
  - Shared service extensions this wave:
    `packages/client/src/react/blueprints/inline-blob-images.ts` (+
    `packages/client/src/react/blueprints/inline-blob-images.test.ts`) — a
    per-mount MutationObserver that swaps relative `/centraid/_vault/blobs/…`
    references (`src`, media-observer's staged `data-prefetch-src`, inline
    `background-image`) to authed `blob:` object URLs through kit-inline's
    `authorizeBlobUrl`, tracking and revoking every URL on teardown; wired for
    every inline app from
    `packages/client/src/react/shell/routes/InlineAppRoute.tsx`.
    `packages/client/src/react/blueprints/kit-inline.ts` exports
    `authorizeBlobUrl` and its vault-blob seam grew
    `packages/client/src/react/blueprints/kit-inline-vault.test.ts`.
    `packages/client/src/react/blueprints/inline-vite-aliases.ts` gained a third
    alias (`./video-frame.js` → `packages/client/src/video-frame.ts`) for
    photos.
  - Type stubs for the 7 new apps' `app-inline` entries and `queries/*` modules
    added to `packages/client/tsconfig.json`, `apps/web/tsconfig.json`,
    `apps/desktop/tsconfig.react.json`; `packages/blueprints/manifest.json`
    regenerated for the 21 new co-located files.
  - Defects found by sequential browser smoke of each app and fixed in-wave:
    notes/docs/locker narrow-drawer flash on mount (fixed by seeding the narrow
    state from the mounted root's width in `useLayoutEffect` before first paint
    and gating drawer transitions behind a post-paint `ready` class), photos
    remount crash (`removeEventListener` on nulls — cleanup now captures element
    refs at wire-time instead of re-resolving by id after React removed them),
    and photos vault images never painting inline (closed by the
    `inline-blob-images` authorizer above).
  - All 8 apps browser-verified in real Chromium against the harness gateway:
    zero iframes, app code only from PWA-origin lazy chunks, writes through the
    replica intent dispatch (receipt toast/Undo intact), and full offline render
    with the gateway process killed. The bundled iframe path remains only behind
    the builder toggle (`AppViewRoute`); `AppFrame.tsx`, `opaqueAppDocument.ts`,
    `appFrameReplicaBridge.ts`, `bridge-script.ts`, and `static-server.ts` are
    byte-for-byte untouched.

- **Phase 5 (app-scoped RPC rename)**: the `/centraid/_tool/centraid_*` shim is
  deleted outright (no dual-route compat window — v0 pre-release policy) and
  replaced with app-scoped routes: `POST /centraid/<appId>/actions/<action>`
  (body `{ input?, intentId? }`), `POST /centraid/<appId>/queries/<query>`
  (body `{ input? }`), and `GET /centraid/<appId>/_describe`
  (`?action=`/`?query=` narrows to one declared handler). Auth, consent,
  vault scoping (`x-centraid-vault`), Companion grants, declared-handler
  dispatch, and draft preview are behavior-identical — only the routing keys
  moved from the body into the URL path. Path builders
  `appActionPath`/`appQueryPath`/`appDescribePath` join `@centraid/protocol`;
  `TOOL_PLANE_PREFIX`/`ROUTES.toolRead`/`ROUTES.toolWrite` are gone.
  Notable deltas: describe became GET (pure read, auto-allowed by the
  read-only device-tier gate, follows the `_`-prefixed reserved-sub-route
  idiom); cross-app web-session calls now fail at the authorizer (401,
  previously 403 at the runtime header check, which is retained as
  defense-in-depth); Companion still cannot describe (companion-access lists
  only `actions`/`queries`); the inline online-fallback `gatewayRead` in
  `packages/client/src/react/blueprints/centraid-inline.ts` was re-pointed
  (recon had claimed the inline path had no HTTP caller — it had one).
  Files: `packages/protocol/src/routes.ts`, `packages/protocol/src/index.ts`,
  `packages/app-engine/src/http/router.ts`, `packages/app-engine/src/runtime.ts`,
  `packages/app-engine/src/http/internal-headers.ts`,
  `packages/app-engine/src/http/bridge-script.ts`,
  `packages/app-engine/src/http/static-server.ts`,
  `packages/app-engine/src/handlers/dispatcher.ts`,
  `packages/app-engine/src/handlers/worker-pool.ts`,
  `packages/app-engine/src/index.ts`,
  `packages/gateway/src/serve/build-gateway.ts`,
  `packages/gateway/src/serve/companion-access.ts`,
  `packages/gateway/src/serve/web-app-sessions.ts`,
  `packages/client/src/react/blueprints/centraid-inline.ts`,
  `packages/client/src/react/shell/routes/opaqueAppDocument.ts`,
  `apps/extension/src/transport.ts`, `scripts/lint-protocol-routes.mjs`,
  `packages/app-engine/src/http/router.test.ts`,
  `packages/app-engine/src/http/bridge-script.test.ts`,
  `packages/app-engine/src/http/internal-headers.test.ts`,
  `packages/gateway/src/lifecycle/draft-preview-over-http.test.ts`,
  `packages/gateway/src/serve/serve-device-tokens.test.ts`,
  `packages/gateway/src/serve/web-app-sessions.contract.test.ts`,
  `packages/gateway/src/serve/serve-git-store.test.ts`,
  `packages/client/src/react/blueprints/centraid-inline.test.ts`,
  `docs/protocol.md`, `packages/app-engine/README.md`,
  `packages/blueprints/visual-harness/mock-centraid.js`,
  `tests/agent-e2e-pairing/flows/extension-companion.mjs`.
- **Phase 6 (docs write-back, completing the early ghost cleanup)**:
  `ARCHITECTURE.md` gains an "App render paths" section (inline default for the
  8 bundled apps vs served/iframe for builder preview + mobile WebViews, with
  the registry as the typed render-path signal); `docs/traps/blueprint-csp.md`
  is scoped to the served path only; `docs/glossary.md` gains **inline app** /
  **served app** rows; `README.md`'s falsified "subscribed iframes re-fetch"
  claim now describes replica-backed inline refresh. `docs/protocol.md`'s RPC
  section was rewritten with Phase 5 above.

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
- **Lazy chunks kept against design-agent advice**: the architecture design recommended
  static imports claiming the desktop `file://` CSP build cannot code-split; the
  desktop build output disproves this (it already emits and lazy-loads
  `react-pdf-*.js` chunks), and the issue's acceptance criteria explicitly require
  per-app lazy chunks. Decision: `React.lazy` per app everywhere; the PWA service
  worker's coverage of lazy chunks is verified as part of the pilot.
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

Phases 2+3 (re-runnable):

```sh
bun run check:pr
# Browser smoke: boot the harness, install tasks (twice: default vault + the
# control session's vaultId via x-centraid-vault), mint a control session as in
# apps/web/tests/e2e/perf-waterfall.spec.ts establishSession(), pin tasks in
# localStorage (centraid.v1.home.userApps), open the Tasks tile:
node --experimental-strip-types apps/web/tests/e2e/server.ts &
# assert: zero <iframe>, app code only from /assets/app-inline-*.js,
# no /centraid/tasks/* requests; kill the server, reload, reopen Tasks:
# the board still renders live replica data.
```

Phase 4 (re-runnable):

```sh
# Per-package suites (green in isolation; full check:pr deferred to end of
# migration by user direction — timeouts under full-parallel turbo load are
# contention, not regressions):
cd packages/blueprints && bun run test   # 235/235
cd packages/client && bun run test       # 1073/1073
# Browser smoke, per app (agenda tally people notes docs locker photos): boot the
# harness as in Phases 2+3, install the app into the control session's vault,
# pin it, open its tile; assert zero <iframe>, code only from
# /assets/app-inline-*.js chunks, a real write lands via replica intent
# dispatch, then kill the server and re-open: full offline render.
node --experimental-strip-types apps/web/tests/e2e/server.ts &
```

Phases 5+6 (re-runnable):

```sh
# Suites covering the RPC rename (all green at commit time):
cd packages/app-engine && bun run test    # 498/498
cd packages/gateway && bun run test       # 827 passed / 6 skipped
cd packages/client && bun run test        # 1073/1073
cd apps/extension && bun run test         # 44/44
bun run lint:protocol-routes              # ok (11 paths)
bun run lint:e2e-flows                    # ok (43 steps)
# Grep proof — zero functional references to the old plane:
grep -rn "_tool/centraid_" packages/ apps/ scripts/ tests/ | grep -v retired
```

Later phases append their own commands here as they land.

## Steering

- Check 1 (all steering events recorded): PASS — User directed to defer full check:pr and lint gates to the end of Phase 7 migration to speed up phase throughput; this direction is recorded in the Phase 4 Verification section and remains unchanged through Phases 5+6.
- Check 2 (no non-steering recorded as steering): PASS — No extraneous steering events misrecorded.

## Audit

- Check 1 (faithful description of diff): PASS — 'What changed' faithfully describes Phases 5–6 work: Phase 5 RPC plane rename (20+ files across protocol/app-engine/gateway/client/extension, 8 test files; old /centraid/_tool/centraid_* shim deleted; new app-scoped routes POST /centraid/<appId>/actions/<action>, POST /centraid/<appId>/queries/<query>, GET /centraid/<appId>/_describe with path builders appActionPath/appQueryPath/appDescribePath added to protocol; TOOL_PLANE_PREFIX/ROUTES.toolRead/ROUTES.toolWrite removed; describe now GET per reserved-sub-route idiom; cross-app calls now fail at authorizer; centraid-inline gatewayRead re-pointed); Phase 6 docs write-back (ARCHITECTURE.md "App render paths" section, blueprint-csp.md scoped to served path, glossary.md inline/served app rows, README.md line 52 replica-backed refresh claim, protocol.md RPC section rewritten).
- Check 2 (checked items realized in diff): PASS — All 9 checklist items remain unchecked; Phases 4–6 work complete and realized per 'What changed' and Verification sections.
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
| claude-code-3f73ae52-798-1784728261-1 | claude-code | 3f73ae52-798f-419a-bac9-2e6ed4a21184 | #505 | claude-fable-5 | 334 | 273144 | 44646993 | 106337 | 379815 | 53.3815 | 667 | 792859 | 67309429 | 269769 | feat(client): inline system apps — shell services + Tasks pilot (#505)Phases 2+3 |
| claude-code-3f73ae52-798-1784728303-1 | claude-code | 3f73ae52-798f-419a-bac9-2e6ed4a21184 | #505 | claude-fable-5 | 2 | 407 | 322015 | 182 | 591 | 0.3362 | 669 | 793266 | 67631444 | 269951 | feat(client): inline system apps — shell services + Tasks pilot (#505)Co-Authore |
| claude-code-3f73ae52-798-1784728480-1 | claude-code | 3f73ae52-798f-419a-bac9-2e6ed4a21184 | #505 | claude-fable-5 | 52 | 24844 | 8506617 | 18673 | 43569 | 9.7513 | 721 | 818110 | 76138061 | 288624 | feat(client): inline system apps — shell services + Tasks pilot (#505)Phases 2+3 |
| claude-code-3f73ae52-798-1784728534-1 | claude-code | 3f73ae52-798f-419a-bac9-2e6ed4a21184 | #505 | claude-fable-5 | 6 | 13728 | 1001823 | 1674 | 15408 | 1.2572 | 727 | 831838 | 77139884 | 290298 | feat(client): inline system apps — shell services + Tasks pilot (#505)Phases 2+3 |
| claude-code-3f73ae52-798-1784738411-1 | claude-code | 3f73ae52-798f-419a-bac9-2e6ed4a21184 | #505 | claude-fable-5 | 470 | 525226 | 80382577 | 185767 | 711463 | 96.2410 | 1197 | 1357064 | 157522461 | 476065 | feat(client): inline remaining seven apps — Phase 4 rollout (#505)All 8 bundled  |
| claude-code-3f73ae52-798-1784738608-1 | claude-code | 3f73ae52-798f-419a-bac9-2e6ed4a21184 | #505 | claude-fable-5 | 18 | 8713 | 975599 | 4334 | 13065 | 1.3014 | 1215 | 1365777 | 158498060 | 480399 | feat(client): inline remaining seven apps — Phase 4 rollout (#505)All 8 bundled  |
| claude-code-3f73ae52-798-1784741090-1 | claude-code | 3f73ae52-798f-419a-bac9-2e6ed4a21184 | #505 | claude-fable-5 | 72 | 84352 | 4550536 | 39827 | 124251 | 7.5970 | 1287 | 1450129 | 163048596 | 520226 | feat(app-engine): app-scoped RPC routes replace the _tool plane (#505)Phase 5: / |
| claude-code-3f73ae52-798-1784741222-1 | claude-code | 3f73ae52-798f-419a-bac9-2e6ed4a21184 | #505 | claude-fable-5 | 4 | 1105 | 296526 | 669 | 1778 | 0.3438 | 1291 | 1451234 | 163345122 | 520895 | feat(app-engine): app-scoped RPC routes replace the _tool plane (#505)Phase 5: / |
