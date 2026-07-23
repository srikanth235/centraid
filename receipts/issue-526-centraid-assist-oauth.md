# Receipt — Issue #526: Centraid Assist OAuth

Issue: https://github.com/srikanth235/centraid/issues/526

## Checklist

### A. Product and security decisions

- [x] **A1.** Freeze the Centraid Assist brand, homepage, privacy, terms, support, and callback URLs in the release evidence checklist.
- [x] **A2.** Document ceremony-only privacy and omit `openid`, `email`, and `profile`.
- [x] **A3.** Document silent refresh and owner-visible reconnect policy.
- [x] **A4.** Freeze gateway-owned state/PKCE, initiating-client and browser binding, TTL/single-use semantics, and redaction rules.
- [x] **A5.** Use code courier only; add no claim store.

### B. Google Cloud operator/release gates

- [ ] **B1.** External evidence pending: GCP project and External consent screen published **In production**.
- [ ] **B2.** External evidence pending: one Web client with only `https://oauth.centraid.dev/callback`.
- [ ] **B3.** External evidence pending: required Google APIs enabled.
- [ ] **B4.** External secret installation pending; code, CI, and runbook accept only Worker-secret bindings and commit no secret.
- [ ] **B5.** External Google verification/CASA evidence pending; the product fail-closes restricted scopes until the evidence-controlled flag is enabled.

### C. Cloudflare Worker

- [x] **C1.** Add Worker, Wrangler configuration, type generation, build/test scripts, and protected continuous deploy workflow.
- [x] **C2.** Implement callback-only code relay; no exchange at the callback.
- [x] **C3.** Implement stateless `/exchange` and `/refresh` proxies with no KV, D1, Durable Object, token store, or per-user record.
- [x] **C4.** Put only code/state/receipt in fixed finish-page fragments.
- [x] **C5.** Return bounded, actionable, secret-free errors.
- [x] **C6.** Add aggregate Analytics Engine events, disable Workers Logs and automatic traces, validate bodies before upstream calls, and document failure-ratio alert evidence.
- [x] **C7.** Add strict CORS/security headers and fixed finish targets.
- [x] **C8 (code).** Add Worker rate-limit bindings, signed browser binding plus HMAC callback receipt, TLS/HSTS headers, and global kill switch.
- [ ] **C8 (zone).** External evidence pending: WAF rate rules, managed rules, Bot Fight Mode, TLS-only, alerts, and DNS/custom-domain controls are enabled in the Cloudflare account.

### D. Handoff mechanisms

- [x] **D1.** Desktop strict `centraid://oauth/finish` courier and cold/warm launch delivery.
- [x] **D2.** PWA same-tab `/oauth/finish` resume with synchronous fragment scrubbing and Iroh re-dial proof.
- [x] **D3.** Desktop open-app page plus manual return-link fallback.
- [x] **D4.** Add no KV/encrypted-claim path.
- [x] **D5.** Bind redemption to gateway state, initiating client session/device, and the browser that entered consent.
- [x] **D6.** Consume state exactly once; reject replay without duplicating tokens/connections.

### E. Gateway

- [x] **E1.** Configure Assist connections without owner credentials or a stored shared secret.
- [x] **E2.** Start gateway-owned state/PKCE ceremonies with client-session/device and surface bindings.
- [x] **E3.** Owner-authenticated handoff validates bindings, exchanges through the Worker, seals tokens, and activates the connection.
- [x] **E4.** Refresh Assist through `/refresh`; preserve direct BYO refresh, single-flight, and rotate-before-use.
- [x] **E5.** Convert terminal auth failures to `needs-auth` with “Reconnect with Centraid Assist.”
- [x] **E6.** Preserve BYO and document its browser-reachable callback requirement.
- [x] **E7.** Exercise Assist without a public gateway URL in integration tests.

### F. Client

- [x] **F1.** Make “Connect with Centraid” primary and BYO an Advanced path.
- [x] **F2.** Wire start, courier completion, health refresh, and safe errors.
- [x] **F3.** Support strict desktop deep links, “Still waiting…”, and manual fallback.
- [x] **F4.** Support PWA same-tab resume across full navigation over the paired Iroh transport.
- [x] **F5.** Add token-custody privacy copy and remove Cloud Console steps from Assist.
- [x] **F6.** Reconnect via Assist and send the stored principal only as Google `login_hint`.

### G. Google v1 scope/provider policy

- [x] **G1.** Request only connector-selected scopes; permit Calendar/Contacts and fail-close Gmail/Drive until restricted verification is enabled; never request identity scopes.
- [x] **G2.** Enable Assist only with exact Worker/callback/client configuration; support exact loopback-only development configuration.
- [x] **G3.** Keep the boundary provider-shaped while leaving Microsoft and mobile couriers to follow-up work.

### H. Tests and verification

- [x] **H1.** Unit-test client/browser binding, replay, expiry, receipts, malformed bodies, and redaction.
- [x] **H2.** Integration-test code courier → private gateway → Worker exchange → sealed token activation.
- [ ] **H3.** External manual matrix pending: real desktop/remote, PWA/remote, embedded desktop, and BYO browser-reachable runs.
- [x] **H4.** Architecture/code tests confirm tokens are excluded from URLs, page/deep-link payloads, browser storage, logs, and Cloudflare storage.
- [ ] **H5.** External production consent and verification evidence pending; no restricted tier is described as GA.

### I. Documentation and operations

- [x] **I1.** Add the Assist threat model to `SECURITY.md`.
- [x] **I2.** Add secret-rotation, revocation, outage, rate-limit, alert, and kill-switch recovery steps.
- [x] **I3.** Add user/operator help for Assist, reconnect, and BYO reachability.
- [x] **I4.** Add this receipt and publish the implementation as a PR linked to #526.

Published in [PR #525](https://github.com/srikanth235/centraid/pull/525), with the Assist implementation added as commit `8b7319dd`.

### Acceptance

- [ ] External H3 evidence pending: a real PWA or desktop client paired to a remote gateway with no public static hostname completes Assist without a user-created GCP project.
- [x] Successful exchange activates the connection; Assist and BYO refresh retain their respective paths.
- [x] The implementation has no Centraid/Cloudflare durable token or per-user connection store, and browser/deep-link payloads contain no tokens.
- [x] Primary UX is one-button Assist; BYO remains Advanced.
- [ ] External production consent evidence is pending; restricted tiers remain fail-closed until verification/CASA evidence exists.
- [ ] The complete H1–H3 matrix and privacy-copy acceptance item remains open: H1–H2 and privacy copy pass in source, while the real-device H3 matrix is pending.

## What changed

Checked-item evidence crosswalk:

- **A1.** Freeze the Centraid Assist brand, homepage, privacy, terms, support, and callback URLs in the release evidence checklist. — `docs/release/oauth-assist-google.md` and the public site content freeze the operator evidence.
- **A2.** Document ceremony-only privacy and omit `openid`, `email`, and `profile`. — `docs/oauth-assist.md`, privacy content, Worker validation, and Worker tests cover the privacy boundary.
- **A3.** Document silent refresh and owner-visible reconnect policy. — `docs/oauth-assist.md`, the broker, and connection-screen behavior define the lifecycle.
- **A4.** Freeze gateway-owned state/PKCE, initiating-client and browser binding, TTL/single-use semantics, and redaction rules. — gateway and Worker ceremony code plus security tests enforce every binding.
- **A5.** Use code courier only; add no claim store. — the Worker has no storage binding and couriers carry only the bounded authorization result.
- **C1.** Add Worker, Wrangler configuration, type generation, build/test scripts, and protected continuous deploy workflow. — `apps/oauth-worker` and `.github/workflows/oauth-worker.yml` provide the complete surface.
- **C2.** Implement callback-only code relay; no exchange at the callback. — `/callback` creates the courier response while `/exchange` alone contacts Google’s token endpoint.
- **C3.** Implement stateless `/exchange` and `/refresh` proxies with no KV, D1, Durable Object, token store, or per-user record. — Wrangler declares only rate-limit and Analytics Engine bindings; tests assert stateless proxy behavior.
- **C4.** Put only code/state/receipt in fixed finish-page fragments. — Worker finish-page builders and tests constrain the fragment fields and destinations.
- **C5.** Return bounded, actionable, secret-free errors. — Worker and gateway error mappers bound messages and redact upstream secrets.
- **C6.** Add aggregate Analytics Engine events, disable Workers Logs and automatic traces, validate bodies before upstream calls, and document failure-ratio alert evidence. — Wrangler observability settings, request schemas, aggregate events, and the release checklist provide evidence.
- **C7.** Add strict CORS/security headers and fixed finish targets. — Worker response helpers and tests verify CORS, CSP, HSTS, referrer, framing, and exact targets.
- **C8 (code).** Add Worker rate-limit bindings, signed browser binding plus HMAC callback receipt, TLS/HSTS headers, and global kill switch. — Worker bindings and cryptographic ceremony tests cover each control.
- **D1.** Desktop strict `centraid://oauth/finish` courier and cold/warm launch delivery. — desktop deep-link parsing, preload buffering, and tests cover both launch states.
- **D2.** PWA same-tab `/oauth/finish` resume with synchronous fragment scrubbing and Iroh re-dial proof. — the handoff module scrubs synchronously and reconnects through the paired transport.
- **D3.** Desktop open-app page plus manual return-link fallback. — the Worker desktop finish page renders both routes without tokens.
- **D4.** Add no KV/encrypted-claim path. — no claim-storage implementation or binding exists.
- **D5.** Bind redemption to gateway state, initiating client session/device, and the browser that entered consent. — gateway and Worker validation require the complete tuple before redemption.
- **D6.** Consume state exactly once; reject replay without duplicating tokens/connections. — gateway state consumption and replay tests prove single-use activation.
- **E1.** Configure Assist connections without owner credentials or a stored shared secret. — Assist configuration stores mode and sealed grant material only; the Worker owns its client secret.
- **E2.** Start gateway-owned state/PKCE ceremonies with client-session/device and surface bindings. — the start route creates and persists the bounded ceremony before returning the authorization URL.
- **E3.** Owner-authenticated handoff validates bindings, exchanges through the Worker, seals tokens, and activates the connection. — connection routes and broker integration tests cover the full activation path.
- **E4.** Refresh Assist through `/refresh`; preserve direct BYO refresh, single-flight, and rotate-before-use. — broker branches retain both refresh paths under the existing single-flight rotation.
- **E5.** Convert terminal auth failures to `needs-auth` with “Reconnect with Centraid Assist.” — broker health mapping and client tests cover terminal versus transient failures.
- **E6.** Preserve BYO and document its browser-reachable callback requirement. — Advanced BYO remains wired and the operator/user docs state its callback constraint.
- **E7.** Exercise Assist without a public gateway URL in integration tests. — mocked Worker exchange tests activate a private gateway connection without a public gateway callback.
- **F1.** Make “Connect with Centraid” primary and BYO an Advanced path. — connection-screen markup and tests assert the primary and Advanced hierarchy.
- **F2.** Wire start, courier completion, health refresh, and safe errors. — the client gateway methods, event bridge, and screen state machine cover the ceremony.
- **F3.** Support strict desktop deep links, “Still waiting…”, and manual fallback. — desktop/client code and UI tests cover all three states.
- **F4.** Support PWA same-tab resume across full navigation over the paired Iroh transport. — boot-time handoff consumption recreates the gateway client before redemption.
- **F5.** Add token-custody privacy copy and remove Cloud Console steps from Assist. — Assist UI and public privacy content explain custody while Cloud Console instructions remain only in Advanced BYO.
- **F6.** Reconnect via Assist and send the stored principal only as Google `login_hint`. — the reconnect start request uses the stored principal solely for the authorization hint.
- **G1.** Request only connector-selected scopes; permit Calendar/Contacts and fail-close Gmail/Drive until restricted verification is enabled; never request identity scopes. — scope policy, exact-scope validation, and tests enforce the tiering.
- **G2.** Enable Assist only with exact Worker/callback/client configuration; support exact loopback-only development configuration. — gateway origin validation and Worker tests reject all other origins and ports.
- **G3.** Keep the boundary provider-shaped while leaving Microsoft and mobile couriers to follow-up work. — protocol/client types remain provider-oriented while documented scope excludes those couriers.
- **H1.** Unit-test client/browser binding, replay, expiry, receipts, malformed bodies, and redaction. — the Worker, gateway, client, and desktop focused suites exercise each case.
- **H2.** Integration-test code courier → private gateway → Worker exchange → sealed token activation. — gateway broker and route integration suites cover the end-to-end source boundary.
- **H4.** Architecture/code tests confirm tokens are excluded from URLs, page/deep-link payloads, browser storage, logs, and Cloudflare storage. — security assertions and architecture configuration cover every prohibited sink.
- **I1.** Add the Assist threat model to `SECURITY.md`. — the new Model B threat-model section records assets, boundaries, abuse cases, and mitigations.
- **I2.** Add secret-rotation, revocation, outage, rate-limit, alert, and kill-switch recovery steps. — `docs/recovery/oauth-assist.md` provides the operator runbook.
- **I3.** Add user/operator help for Assist, reconnect, and BYO reachability. — README, OAuth Assist docs, release docs, and connection UI provide the guidance.
- **I4.** Add this receipt and publish the implementation as a PR linked to #526. — published in [PR #525](https://github.com/srikanth235/centraid/pull/525) as commit `8b7319dd`.
- Successful exchange activates the connection; Assist and BYO refresh retain their respective paths. — gateway integration tests verify activation and both refresh modes.
- The implementation has no Centraid/Cloudflare durable token or per-user connection store, and browser/deep-link payloads contain no tokens. — Worker configuration, courier schemas, and custody tests verify the zero-storage boundary.
- Primary UX is one-button Assist; BYO remains Advanced. — connection-screen tests verify the final hierarchy.

Worker and protected delivery surface:

- `.github/workflows/oauth-worker.yml`
- `.gitignore`
- `.oxlintrc.json`
- `apps/oauth-worker/.dev.vars.example`
- `apps/oauth-worker/package.json`
- `apps/oauth-worker/src/env.d.ts`
- `apps/oauth-worker/src/index.test.ts`
- `apps/oauth-worker/src/index.ts`
- `apps/oauth-worker/tsconfig.json`
- `apps/oauth-worker/vitest.config.ts`
- `apps/oauth-worker/worker-configuration.d.ts` — generated by `bun run cf-typegen` during typecheck and ignored rather than checked in.
- `apps/oauth-worker/wrangler.jsonc`
- `apps/web/wrangler.json`
- `bun.lock`
- `vitest.config.ts`

Gateway, vault, and protocol:

- `packages/app-engine/src/http/http-server.ts`
- `packages/gateway/src/cli/cli.ts`
- `packages/gateway/src/index.ts`
- `packages/gateway/src/routes/connections-routes.test.ts`
- `packages/gateway/src/routes/connections-routes.ts`
- `packages/gateway/src/routes/lifecycle-automation-routes.ts`
- `packages/gateway/src/serve/assist-oauth.test.ts`
- `packages/gateway/src/serve/assist-oauth.ts`
- `packages/gateway/src/serve/build-gateway.ts`
- `packages/gateway/src/serve/connection-broker.test.ts`
- `packages/gateway/src/serve/connection-broker.ts`
- `packages/protocol/src/capabilities.ts`
- `packages/protocol/src/index.ts`
- `packages/protocol/src/routes.ts`
- `packages/vault/src/commands/sync.test.ts`
- `packages/vault/src/commands/sync.ts`
- `packages/vault/src/schema/sync.ts`
- `scripts/lint-protocol-routes.mjs`

Desktop, PWA, and Connectors UX:

- `apps/desktop/src/main/app-chrome.ts`
- `apps/desktop/src/main/local-gateway.ts`
- `apps/desktop/src/main/oauth-deep-link.test.ts`
- `apps/desktop/src/main/oauth-deep-link.ts`
- `apps/desktop/src/preload.ts`
- `packages/client/src/assist-oauth-events.ts`
- `packages/client/src/assist-oauth-handoff.test.ts`
- `packages/client/src/assist-oauth-handoff.ts`
- `packages/client/src/centraid-api.d.ts`
- `packages/client/src/gateway-client-connections.test.ts`
- `packages/client/src/gateway-client-connections.ts`
- `packages/client/src/gateway-client-core.ts`
- `packages/client/src/react/boot.tsx`
- `packages/client/src/react/screens/AutomationEditorConnectorsPicker.tsx`
- `packages/client/src/react/screens/SettingsConnectionsScreen.module.css`
- `packages/client/src/react/screens/SettingsConnectionsScreen.test.tsx`
- `packages/client/src/react/screens/SettingsConnectionsScreen.tsx`
- `packages/client/src/react/screens/connectorBrandMarks.tsx`
- `packages/client/src/react/shell/glyphs.tsx`
- `packages/client/src/react/shell/routes/ConnectorsRoute.tsx`
- `packages/client/src/react/shell/routes/automationEditorPrefill.test.ts`
- `packages/client/src/react/shell/routes/automationEditorVault.test.ts`
- `packages/client/src/react/shell/routes/connectorAssistantTools.ts` — removed unused #525 shim so the stacked PR passes the repository dead-code gate.
- `packages/client/src/react/shell/routes/settingsConnectionsData.test.ts`
- `packages/client/src/react/shell/routes/settingsConnectionsData.ts`

Privacy, architecture, release, and recovery:

- `AGENTS.md`
- `ARCHITECTURE.md`
- `CHANGELOG.md`
- `README.md`
- `SECURITY.md`
- `docs/enrollment.md`
- `docs/logs.md`
- `docs/oauth-assist.md`
- `docs/recovery/oauth-assist.md`
- `docs/release.md`
- `docs/release/oauth-assist-google.md`
- `scripts/docs-site/smoke.mjs`
- `scripts/docs-site/src/components/SiteFooter.astro`
- `scripts/docs-site/src/content/data.html`
- `scripts/docs-site/src/content/learn.html`
- `scripts/docs-site/src/content/privacy.html`
- `scripts/docs-site/src/content/start.html`
- `scripts/docs-site/src/content/terms.html`
- `scripts/docs-site/src/pages/privacy.astro`
- `scripts/docs-site/src/pages/terms.astro`
- `scripts/home-site/public/index.html`
- `scripts/release/publish.mjs`
- `scripts/release/surfaces.mjs`
- `scripts/release/surfaces.test.mjs`
- `receipts/issue-526-centraid-assist-oauth.md`

## Out of scope

- Microsoft Assist and the Expo/mobile courier.
- A hosted API proxy, connection directory, token vault, KV/D1 claim store, or other per-user Cloudflare persistence.
- Replacing BYO.
- Performing production Google/Cloudflare account changes from a source-code PR. Those controls are fail-closed and require the evidence checklist before enablement.

## Decisions

- Freeze `oauth.centraid.dev` and `https://oauth.centraid.dev/callback`; do not accept alternate production origins or redirect targets.
- Treat the client-session value as a ceremony binding, not an auth secret; bearer auth and device/vault addressing remain independently required.
- Enter Google through the Worker's fragment-scrubbing `/start` page so a signed HttpOnly browser binding—absent from the shareable Google authorization URL—is required at callback and exchange.
- A copied handoff from the wrong client must not burn the valid client’s state, but an accepted/denied handoff is single-use.
- Treat the HMAC as proof of a recent Worker-accepted code/state/browser-binding tuple, not proof that Google originated the callback HTTP request; Google proves code validity at exchange.
- Keep Assist disabled unless all public configuration exists. Keep restricted scopes separately disabled until verification evidence exists.
- Permit only `https://oauth.centraid.dev` in production and exactly `http://127.0.0.1:8787` in local development before posting exchange or refresh material.
- Disable Workers Logs and automatic tracing because callback query strings contain code/state and Cloudflare traces retain full URLs; use aggregate Analytics Engine counters only.
- Retry transient Worker/Google failures without flipping health; only terminal grant failures require reconnect.
- Do not falsely certify account-side Google, Cloudflare, or real-device evidence in source control.

## Verification

Focused verification completed during implementation:

```text
bun run --cwd apps/oauth-worker typecheck
bun run --cwd apps/oauth-worker test
bun run --cwd apps/oauth-worker build
bun run --cwd packages/protocol build
bun run --cwd packages/protocol typecheck
bun run --cwd packages/protocol test
bun run --cwd packages/vault test -- src/commands/sync.test.ts
bun run --cwd apps/desktop test -- src/main/oauth-deep-link.test.ts
bun run --cwd packages/client test -- src/assist-oauth-handoff.test.ts src/gateway-client-connections.test.ts src/react/screens/SettingsConnectionsScreen.test.tsx src/react/shell/routes/settingsConnectionsData.test.ts
bun run --cwd packages/gateway test -- src/serve/assist-oauth.test.ts src/serve/connection-broker.test.ts src/routes/connections-routes.test.ts
bun run docs:build
bun run docs:smoke
bun run release:matrix
bun test scripts/release/surfaces.test.mjs
```

Repository-wide verification:

```text
PASS — bun run check:pr
       36/36 affected-package tasks passed; gateway 840 passed / 6 skipped.
PASS — bun run build
       17/17 build tasks passed, including the OAuth Worker Wrangler dry-run.
PASS — bun run coverage
       556 test files passed / 3 skipped; 4,853 tests passed / 35 skipped;
       71.23% statements, 77.76% branches, 81.45% functions, 71.23% lines.
PASS — targeted OAuth security suites
       Worker 11/11; gateway Assist 4/4; broker + HTTP routes 18/18.
NOTE — bun run lint:actions
       The optional local actionlint binary is not installed. The workflow YAML
       parses successfully; the pinned actionlint run remains part of CI.
```

## Audit

**Check 1 — What changed faithfully describes the diff**

PASS — a fresh-context auditor mechanically compared all 83 changed/untracked
paths with this receipt; every path is named and the groupings faithfully
describe their surfaces.

**Check 2 — All checked checklist items are realized in the diff**

PASS — the fresh-context security audit found and re-verified state/PKCE,
browser/client-session/device binding, receipt validation, replay/expiry, exact
Worker origins, scope gating, redaction, token custody, refresh behavior, and
BYO preservation. Its initial desktop IPC race and over-broad development-origin
findings were fixed and independently re-audited; external/manual gates remain
unchecked.

**Check 3 — Checklist mirrors the issue**

PASS — A1–I4 and all six acceptance items are represented one-for-one;
account-side/manual H3 and production-evidence gates remain explicitly
unchecked.

## Accounting

### Steering

(no rows — no interrupt/correction events recorded for this change set)

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019f8e48-8ec-1784810655-1 | codex | 019f8e48-8ec9-7800-9630-fb1e00b1121b | #526 | gpt-5.6-sol | 2171357 | 0 | 87407360 | 217753 | 2389110 | 30.5465 | 2171357 | 0 | 87407360 | 217753 | feat(oauth): add Centraid Assist code courier (#526) -m governance: allow-toolch |
| codex-019f8e48-8ec-1784810888-1 | codex | 019f8e48-8ec9-7800-9630-fb1e00b1121b | #526 | gpt-5.6-sol | 32203 | 0 | 1142272 | 7082 | 39285 | 0.4723 | 2203560 | 0 | 88549632 | 224835 | feat(oauth): add Centraid Assist code courier (#526) -m governance: allow-toolch |
| codex-019f8e48-8ec-1784810962-1 | codex | 019f8e48-8ec9-7800-9630-fb1e00b1121b | #526 | gpt-5.6-sol | 7981 | 0 | 461568 | 1256 | 9237 | 0.1542 | 2211541 | 0 | 89011200 | 226091 | feat(oauth): add Centraid Assist code courier (#526) -m governance: allow-toolch |
| codex-019f8e48-8ec-1784811129-1 | codex | 019f8e48-8ec9-7800-9630-fb1e00b1121b | #526 | gpt-5.6-sol | 11925 | 0 | 1001984 | 2392 | 14317 | 0.3162 | 2223466 | 0 | 90013184 | 228483 | feat(oauth): add Centraid Assist code courier (#526) -m governance: allow-toolch |
| codex-019f8e48-8ec-1784812419-1 | codex | 019f8e48-8ec9-7800-9630-fb1e00b1121b | #526 | gpt-5.6-sol | 229904 | 0 | 5777920 | 13164 | 243068 | 2.2167 | 2453370 | 0 | 95791104 | 241647 | docs(oauth): record Assist PR evidence (#526) |
| codex-019f8e48-8ec-1784813380-1 | codex | 019f8e48-8ec9-7800-9630-fb1e00b1121b | #526 | gpt-5.6-sol | 227809 | 0 | 7411200 | 10877 | 238686 | 2.5855 | 2681179 | 0 | 103202304 | 252524 | Merge origin/main into grok/connectors-platform-524 (#526) |
| codex-019f8e48-8ec-1784813485-1 | codex | 019f8e48-8ec9-7800-9630-fb1e00b1121b | #526 | gpt-5.6-sol | 29107 | 0 | 308736 | 1059 | 30166 | 0.1658 | 2710286 | 0 | 103511040 | 253583 | Merge origin/main into grok/connectors-platform-524 (#526) |
## Steering

**Check 1 — every human-steering event is recorded in ### Steering under ## Accounting**

PASS — No interrupt or mid-task correction events; the empty steering table is correct.

**Check 2 — no non-steering message is recorded as a steering event**

PASS — No non-steering message is recorded.
