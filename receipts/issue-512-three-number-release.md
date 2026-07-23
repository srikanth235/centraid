# issue-512 — three-number versioning + multi-surface release synthesis

<!-- governance: allow-receipt-per-issue This receipt was independently added on main and re-added in the historical #505 branch before the histories merged; it must not become the file-coverage anchor for #505. -->

## Checklist

- [x] Handshake does not refuse on product version skew
- [x] Protocol version constants + min-supported window documented
- [x] release surfaces matrix + prepare enrichment
- [x] docs/release.md + protocol + decisions updated
- [x] Unit/integration tests updated for protocol_mismatch

## What changed

Handshake does not refuse on product version skew:

- `packages/protocol/src/version.ts` — product / protocol / minSupported constants
- `packages/protocol/src/handshake.ts` — judge protocol window only; emit `protocolVersion` + `minSupportedProtocol`
- `packages/protocol/src/handshake.test.ts`, `packages/protocol/src/index.ts`
- `packages/client/src/version-handshake.ts`, `packages/client/src/version-handshake.test.ts`, `packages/client/src/centraid-api.d.ts`
- `apps/desktop/src/main/version-handshake.ts`, `apps/desktop/src/main/version-handshake.test.ts`
- `apps/desktop/src/main/gateway-monitor-core.ts`, `apps/desktop/src/main/gateway-monitor-core.test.ts`
- `apps/desktop/src/main/gateway-connectivity-core.ts`, `apps/desktop/src/main/gateway-connectivity-core.test.ts`
- `apps/web/src/connectivity.ts`
- `packages/cli/src/cli.ts`
- `packages/gateway/src/version.ts`, `packages/gateway/src/index.ts`
- `packages/gateway/src/cli/endpoint-host.ts`, `packages/gateway/src/serve/gateway-diagnostics.ts`
- `packages/tunnel/src/gateway-endpoint.ts` — pair response protocol fields

Protocol version constants + min-supported window documented:

- `docs/protocol.md`, `packages/protocol/README.md`, `docs/decisions.md` R1–R5

release surfaces matrix + prepare enrichment:

- `scripts/release/surfaces.mjs`, `scripts/release/matrix.mjs`, `scripts/release/surfaces.test.mjs`
- `scripts/release/prepare.mjs`, `scripts/release/publish.mjs` (`--surfaces`), `scripts/release/verify-secrets.mjs`
- root `package.json` scripts `release:matrix`, `release:surfaces:test`

docs/release.md + protocol + decisions updated:

- `docs/release.md` (full rewrite with three numbers + surfaces)
- `docs/recovery/release.md`, `ARCHITECTURE.md`, `AGENTS.md`, `CHANGELOG.md`
- `receipts/issue-512-three-number-release.md`

Unit/integration tests updated for protocol_mismatch:

- protocol, client, desktop monitor/connectivity tests

## Decisions

- R1–R5 as recorded in docs/decisions.md
- Keep capability flags for features; protocol int is connect floor only
- Default ship set: desktop, gateway-image, gateway-npm (not mobile)
- companion-v* demoted to rebuild note, not second product line

## Out of scope

- Splitting vault storage schemaEpoch from wire protocol into separate migration system
- Changing extension-release.yml triggers
- Live npm publish / first multi-OS CI pack (depends on #510 merge)
- Automatic EAS store submit on every product tag

## Verification

```sh
bun run release:surfaces:test
bun run release:matrix -- --json
node scripts/release/publish.mjs --version 0.1.1 --issue 512 --dry-run --surfaces desktop,gateway-npm
bunx turbo run test --filter=@centraid/protocol --filter=@centraid/client --filter=@centraid/desktop
bun run check:pr
```

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Steering

**PASS.**

No mid-task human-steering interrupts or corrections during implementation of #512.

1. **Every human-steering event is recorded as a row:** None — table headers only.
2. **No non-steering message is recorded as steering:** Prior session messages were Q&A on versioning and multi-surface release research; “go ahead with synthesis and implement it entirely!” is the **task start** for this implementation.

## Audit

**PASS.**

1. **What changed describes the diff:** protocol handshake + release scripts + docs + client/desktop test updates named above.
2. **Checklist items realized:** product skew allowed in tests; protocol constants exported; matrix/prepare/publish ship set; docs R1–R5; tests expect `protocol_mismatch`.
3. **Mirrors issue acceptance:** #512 acceptance bullets map to checklist.
