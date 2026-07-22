# issue-504 — multi-client, packaging, and protocol polish
<!-- governance: allow-receipt-per-issue mega-PR intentionally covers every #504 batch file surface in one receipt -->

Issue #504 is a phased backlog. This receipt covers **all batches shipped in one PR** at maintainer request (issue text preferred phased PRs; overridden for this delivery).

## Checklist

- [x] Batch 0: Host allowlist + non-reflective credentialed CORS; real HTTP tests
- [x] Batch 1: platform-gating, client-keying, glossary Inconsistencies, store atomicity, RPC naming, stream authority, config-ownership packaging, SECURITY.md control-plane
- [x] Batch 2: `@centraid/protocol` (version/epoch, handshake, capabilities, routes); remove MUST-track mirror; info carries capabilities; extension + CLI consume package; route-literal drift script in `check:pr`
- [x] Batch 3: product CLI `centraid` (status/info/health/list); auth story documented; streaming explicitly deferred
- [x] Batch 4: tool catalog named in runners.md; MCP remains the adapter; native injection gated
- [x] Batch 5: package tracer, install smoke, Dockerfile, flake.nix notes, single unit-file writer docs, path-filtered workflow
- [x] Batch 5 follow-on: Docker harden (non-root, HEALTHCHECK, OCI labels, lean assemble, `.dockerignore`), container smoke in CI, Host allowlist CLI/env, operator docs
- [x] Batch 6: TESTING.md smoke schedule; ACP min-version drift script in `check:pr`

## What changed

### Batch 0 — control plane
- `packages/app-engine/src/http/request-boundary.ts` + `request-boundary.test.ts` — pure Host + CORS decisions
- `packages/app-engine/src/http/http-server.ts` + `http-server.test.ts` — Host refuse before handlers; credentialed CORS only for session origins / Bearer intent
- `packages/gateway/src/serve/web-app-sessions.ts` — `knownShellOrigins()`
- `packages/gateway/src/serve/serve.ts` — wires `credentialedCorsOrigins`

### Batch 2 — protocol root
- `packages/protocol/**` (`package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md`, `src/index.ts`, `src/version.ts`, `src/handshake.ts`, `src/handshake.test.ts`, `src/capabilities.ts`, `src/routes.ts`)
- `packages/gateway/src/version.ts` re-exports protocol
- `packages/gateway/src/routes/gateway-info-routes.ts` — capabilities on info
- `packages/client/src/version-handshake.ts` — no MUST-track mirror
- `packages/client/package.json`, `packages/gateway/package.json`, `apps/extension/package.json` — depend on protocol
- `apps/extension/src/{companion-api,transport,worker}.ts` + tests — `ROUTES`
- `scripts/lint-protocol-routes.mjs` — route-literal drift in `check:pr`
- `vitest.config.ts`, `knip.json`, root `package.json` — wire new packages + lints

### Batch 3 — product CLI
- `packages/cli/**` (`package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md`, `src/cli.ts`, `src/auth.ts`, `src/auth.test.ts`, `src/client.ts`, `src/client.test.ts`)
- `docs/dev-environment.md` — product CLI row

### Batch 4–6 + packaging + docs
- `docs/runners.md` — tool catalog registration surface
- `docs/platform-gating.md`, `docs/client-keying.md`, `docs/glossary.md`, `docs/coding-standards.md`, `docs/protocol.md`, `docs/config-ownership.md`, `AGENTS.md`, `SECURITY.md`, `TESTING.md`, `README.md` (Docker operator section)
- `scripts/gateway-package/trace.mjs`, `smoke.mjs`, `probe.mjs`, `probe.test.mjs`, `assemble-runtime.mjs`
- `Dockerfile` (non-root 10001, HEALTHCHECK, OCI labels, multi-stage assemble), `.dockerignore`
- `flake.nix` (explicit STUB — docs text only)
- `.github/workflows/gateway-package.yml` — Bun cache, path-filter PR/`main` parity, host smoke + `docker build` + container smoke with `/data` volume
- `packages/gateway/src/cli/allowed-hosts.ts` (+ tests); `serve` + CLI `--allowed-host` / `CENTRAID_ALLOWED_HOSTS`
- `scripts/lint-acp-min-versions.mjs`
- `bun.lock`

## Decisions

- One mega-PR for all batches per explicit OBJECTIVE override of the issue's phased-PR guidance.
- Protocol package is types + constants only (no runtime schema validation).
- Product CLI streaming deferred (documented in CLI help/README).
- Route-literal lint scopes extension + CLI first (historical gateway literals migrate gradually).
- Nix flake is an explicit **stub** (docs text only); not a full FOD/bun2nix translation yet.
- Credentialed CORS allowlist from live session shell origins + Bearer intent (not ambient cookies alone).
- Docker image: non-root, HEALTHCHECK, OCI labels, lean runtime assemble; CI builds and smokes the **image** (not only host binary). GHCR publish / multi-arch / Cosign deferred.

## Out of scope

- Pairing-as-a-device CLI auth; extension pairing product surface (#462 C4 beyond consuming protocol routes)
- Runtime schema validation / AOT validators
- Full Nix FOD / bun2nix translation; real `centraid-gateway` Nix derivation
- GHCR publish, multi-arch Buildx, Cosign, SBOM attach
- Desktop packaging parity; PR-template process; tunnel envelope types in protocol
- Product CLI streaming verbs (named defer under this issue)
- Making packaging workflow a branch-protection required check

## Verification

```sh
bun run --cwd packages/app-engine test -- src/http/http-server.test.ts src/http/request-boundary.test.ts
bun run --cwd packages/protocol test
bun run --cwd packages/cli test
bun run --cwd packages/gateway test -- src/serve/web-app-sessions.contract.test.ts src/routes/lifecycle-automation-routes.test.ts src/cli/admin.test.ts
node scripts/lint-protocol-routes.mjs
node scripts/lint-acp-min-versions.mjs
bun run check:pr
```

Follow-up commit (green `check:pr`):
- `build-gateway.ts` optional `runTurn` inject; lifecycle compile test fails fast agentless
- `admin.test.ts` enrollment-revoke watch wait hardened
- `gateway-package.yml` uses `turbo run build --filter=@centraid/gateway` full dependency graph
- `packages/cli/src/cli.integration.test.ts` drives `main()` status/health/list
- Real bin: `node packages/cli/dist/cli.js status|health|list` against `centraid-gateway serve` (captured under implementer `cli.log`)

Packaging harden follow-up:
- `node --test scripts/gateway-package/probe.test.mjs`
- `bun run --cwd packages/gateway test -- src/cli/allowed-hosts.test.ts`
- `bun run gateway:package:trace` / `bun run gateway:package:smoke`
- CI: `docker build` + `smoke.mjs --base-url` with volume at `/data`
- Symlink rewrite + packages-only assemble: Docker uses `--packages-only` + fresh `bun install --production` (bun `.bun` store is not relocatable by symlink rewrite); host tests still copy+rewrite
- `node --test scripts/gateway-package/assemble-runtime.test.mjs` + isolated-tree smoke
- Local Docker: `docker build -t centraid-gateway:local-smoke .` then named-volume smoke ×2 (`gateway smoke OK` 401 on info); image ~1.7GB, non-root, HEALTHCHECK, git present
- Residual: native tunnel skipped without cargo (JS iroh fallback); host bind-mount needs uid 10001 chown — prefer named volume

## Steering

Primary human steering events this session (fresh-context auditor; no full transcript coordinates):

1. User asked whether work covers the entire issue scope (clarification mid-task) — **type:** correction, **reason:** scope clarification then expanded to all batches.
2. User instructed to ignore branching and ship all batches in a single PR with green build — **type:** correction, **reason:** objective override of the issue’s phased-PR plan.

### Steering rows

| type | tier | reason |
| --- | --- | --- |
| correction | classifier | scope expand to all batches + single PR |

**Verdict:** PASS — both events are mid-task corrections (classifier); no non-steering messages recorded as steering. Formal ledger rows under `## Accounting` → `### Steering` (manual append; `ledger.py append-row` not run in this auditor sandbox — **ledger append deferred** for hook re-stamp if needed).

## Accounting

<!-- Accounting rows: steering recorded by fresh-context auditor; costs filled by pre-commit hooks. -->

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-issue504all-20260722-1 | issue504-all-batches-auditor | #504 | correction | classifier | Scope clarification then expand to all #504 batches | pending | 1 | 2026-07-22T12:00:00.000Z |
| steer-issue504all-20260722-2 | issue504-all-batches-auditor | #504 | correction | classifier | Ignore branching; ship all batches in one PR with green build | pending | 2 | 2026-07-22T12:05:00.000Z |

## Audit

Fresh-context auditor against receipt checklist + issue #504 acceptance (batches 0–6, mega-PR override). Branch tip `c0610b88` matches `main`; delivery is uncommitted tree. Spot-checked receipt paths in the working tree (no `git diff` binary in this auditor; evidence is file contents + package.json wiring).

1. **What changed faithfully describes the diff:** **PASS** — Batch 0 surfaces (`request-boundary.ts` Host allowlist + `decideCors`, `http-server.ts`/`http-server.test.ts`, `knownShellOrigins` / `credentialedCorsOrigins` wiring) present; Batch 2 `@centraid/protocol` package + re-exports in gateway/client + extension `ROUTES` imports; Batch 3 `@centraid/cli` + `docs/dev-environment.md` product CLI row; Batch 4 `docs/runners.md` tool catalog section; Batch 5 tracer/smoke/Dockerfile/flake.nix/`gateway-package.yml`; Batch 6 TESTING schedule column + `lint-acp-min-versions.mjs` in `check:pr`. Named paths match live tree.

2. **Each [x] checklist item is realized in the diff:** **PASS** — Batch 0: Host refuse + non-reflective credentialed CORS + HTTP tests (`http-server.test.ts` evil Host 400; foreign Origin without credentials). Batch 1: `docs/platform-gating.md`, `client-keying.md`, glossary Inconsistencies, coding-standards store atomicity, protocol RPC naming + stream authority, config-ownership packaging single-writer, SECURITY.md control-plane, AGENTS.md index. Batch 2: protocol package, MUST-track gone, info `capabilities` via `buildGatewayInfoPayload`, extension+CLI consume, `lint-protocol-routes` in `check:pr`. Batch 3: CLI status/info/health/list; auth in help/README; streaming explicitly deferred. Batch 4: runners.md names catalog; MCP adapter; native gated. Batch 5: tracer + native decision, smoke, Dockerfile, flake notes, unit-writer docs, path-filtered workflow. Batch 6: TESTING schedule column; ACP min-version script in `check:pr`.

3. **Checklist mirrors the issue’s security/docs/protocol/cli/tools/packaging/tests acceptance for the batches claimed:** **PASS** — Receipt batches 0–6 map to issue AC groups Security / Docs / Protocol / CLI / Tools / Packaging / Tests·CI. Mega-PR overrides issue “not one PR” guidance (documented in receipt Decisions). Documented residuals (types-only protocol, streaming deferred under #504, Nix not full FOD, route lint scoped to extension+CLI, Docker image path present while CI smoke is external observer not full `docker build`) match issue recommendations and Out of scope — not silent omissions of claimed [x] rows.
