# Receipt: #583 pairing CLI/e2e readiness after #568 endpointTicket auth gate

## Checklist

- [x] CLI readiness handshake presents landlord bearer before requiring `endpointTicket`
- [x] Loopback pairing e2e harness authenticates `/_gateway/info` for readiness
- [x] Docker harness readiness no longer waits for `token:` stdout
- [x] Unit tests only serve `endpointTicket` when Authorization is present
- [ ] GitHub Actions `e2e` `suite=pairing` four jobs green on a remote branch

## What changed

CLI readiness handshake presents landlord bearer before requiring `endpointTicket`:

- `packages/gateway/src/cli/device-admin.ts` — `commandPair` loads `endpoint-key.bin`, derives the landlord bearer, then `handshakeGateway(baseUrl, landlordBearer, …)` before requiring `endpointTicket`.
- `packages/gateway/src/cli/founding-admin.ts` — same order for `commandInitTicket`.
- `packages/gateway/src/cli/status-admin.ts` — live `status` handshake uses the bearer when the key exists so dial tickets can appear.

Loopback pairing e2e harness authenticates `/_gateway/info` for readiness:

- `tests/agent-e2e-pairing/lib/harness.mjs` — readiness `fetch` to `/centraid/_gateway/info` sends `Authorization: Bearer ${wanted.token}`.

Docker harness readiness no longer waits for `token:` stdout:

- `tests/agent-e2e-pairing/lib/docker-harness.mjs` — `waitForGatewayReady` only needs `listening on` + `endpoint:`; drops the retired `token:` log scrape.

Unit tests only serve `endpointTicket` when Authorization is present:

- `packages/gateway/src/cli/admin.test.ts`
- `packages/gateway/src/cli/founding-admin.test.ts`
- `packages/gateway/src/cli/status-admin.test.ts`

Docs:

- `tests/agent-e2e-pairing/AGENTS.md` — gotcha that `endpointTicket` is auth-gated.

## Out of scope

- Changing the product rule that anonymous GETs omit `endpointTicket`.
- Full nightly `e2e` suite (desktop/web/mobile) and unrelated red jobs.
- Merge to `main`.

## Verification

Local CLI unit tests (auth-gated ticket mocks):

```sh
cd packages/gateway && bun run test -- src/cli/admin.test.ts src/cli/founding-admin.test.ts src/cli/status-admin.test.ts
```

Local loopback pairing flows (after gateway+tunnel build):

```sh
node tests/agent-e2e-pairing/flows/device-pairing-lifecycle.mjs
node tests/agent-e2e-pairing/flows/vps-phone-founding.mjs
node tests/agent-e2e-pairing/flows/pairing-ticket-hygiene.mjs
```

Remote pairing CI (acceptance item remaining until run green):

```sh
gh workflow run e2e.yml --ref fix/pairing-568-auth-callers -f suite=pairing
```

## Decisions

- Reuse #568's auth gate rather than loosening public `/_gateway/info`; only fix callers that must see dial tickets.
- Track as new issue #583 because receipt-per-issue forbids a second receipt for #568 and the existing #568 receipt is frozen on `main`.

## Audit

### Check 1: "## What changed" faithfully describes the diff

**Verdict: PASS**

Diff is the CLI admin trio (`device-admin.ts` / `founding-admin.ts` / `status-admin.ts`) reordering handshake after loading the endpoint key and passing `landlordBearer`; harness Authorization on readiness fetch; docker-harness dropping `token:` scrape; unit-test mocks that omit `endpointTicket` without Authorization; AGENTS.md gotcha update; this receipt.

### Check 2: Each "- [x]" checklist item is realized in the diff

**Verdict: PASS**

All four checked items map to the files above. The remote four-job green item stays unchecked until GitHub Actions evidence lands.

### Check 3: The checklist mirrors the issue's checklist

**Verdict: PASS**

Matches #583 acceptance criteria one-to-one.

## Steering

### Check 1: Every human-steering event in the session transcript is recorded as a row

**Verdict: PASS**

No interrupt/correction steering events in this session for #583 — the work followed the user goal to land the already-identified fix and green pairing CI. No `### Steering` data rows.

### Check 2: No non-steering message is recorded as steering

**Verdict: PASS**

No steering rows recorded.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Steering

### Costs
