# AGENTS.md — device-pairing e2e

Notes for any agent (or human) writing or running pairing flows. Pair this
with [README.md](README.md); repo-wide rules in [../../AGENTS.md](../../AGENTS.md)
still apply.

## What this layer is for

The device-pairing ceremony (issue #289) crosses three processes — daemon,
admin CLI, device — and the unit tests fake at least one of them. A flow here
fakes none: real `centraid-gateway serve`, real `pair`/`devices` CLI
invocations, real iroh QUIC dialing from `@centraid/tunnel`. Use it whenever
you touch `pairing-store.ts`, `enrollment-store.ts`, `endpoint-host.ts`,
`device-admin.ts`, or the tunnel's `gateway-endpoint.ts` / `client.ts`, and
before claiming any pairing change "works".

## Running

```sh
node tests/agent-e2e-pairing/flows/device-pairing-lifecycle.mjs   # happy path + restart + revoke
node tests/agent-e2e-pairing/flows/pairing-ticket-hygiene.mjs     # burn / expiry / refusal
node tests/agent-e2e-pairing/flows/cross-network-relay.mjs        # real relay transport, needs Docker
```

Verdict at `runs/<runId>/verdict.md`; daemon output at `runs/<runId>/gateway.log`.
On FAIL the workspace is kept — `devices.json`, `pairing-tickets.json`, and
`endpoint.json` under `runs/<runId>/workspace/gateway/` are the ground truth
to inspect (for `cross-network-relay`, the equivalent files land under
`runs/<runId>/workspace/` directly, dumped via `docker exec` before the
gateway container is torn down).

`cross-network-relay` is a different tool for a different job: the other two
flows prove ceremony/hygiene semantics over a loopback transport (device
relays explicitly disabled); this one proves the ceremony survives the REAL
n0 relay/hole-punch path, by running gateway and device in separate Docker
containers on separate, non-interconnected bridge networks. Use it when you
touch `packages/tunnel/src/client.ts`, `iroh.ts`, or anything about how a
connection actually gets negotiated — the other two flows will pass even if
that layer is broken, because they never dial anything but loopback. See
[flows/cross-network-relay.md](flows/cross-network-relay.md) for the full
design, including two host-specific gotchas its harness
(`lib/docker-harness.mjs`) works around: the container needs its own
platform's `@number0/iroh` native addon (fetched additively if the host's own
`bun install` targeted a different platform), and at least one real Docker
install (OrbStack) doesn't isolate bridge networks from each other by
default the way `ubuntu-latest`'s does — the harness enforces it explicitly
with `DOCKER-USER` firewall rules and *proves* it with a raw TCP probe before
running any part of the ceremony, rather than trusting the driver.

## Conventions

- **Slug = filename = `runFlow()` first arg.** Same as the other e2e tiers.
- **Throw on failure; return `{ pass: true, notes }` on success.** No
  try/catch that swallows — let the harness write the FAIL verdict.
- **`ctx.note(msg)` for observations the verdict should keep** ("replay
  refused (invalid_ticket)").
- **Assert on-disk state, not just wire responses.** Enrollment truth is
  `devices.json`; read it via `ctx.readJson('devices.json')`.
- **Every negative check needs a positive control nearby.** "Tunnel refused"
  only means something in a flow where an enrolled device tunneled
  successfully (or would — `expectTunnelRefused` throws if admission
  sneaks through).
- **QUIC refusals are racy by nature — use `ctx.expectTunnelRefused`.** It
  encodes the request → `connection.closed()` → request-again pattern from
  `packages/tunnel/src/gateway-endpoint.test.ts`; don't hand-roll a single
  request and hope the close beat it.
- **Expired-ticket checks: mint with `ttlMinutes: 0.001` and sleep ≥ 500ms.**
  Don't shave the sleep to make the flow faster; the mint→redeem roundtrip
  must land clearly past expiry.
- **Fresh device per trust boundary.** A device that failed to pair must stay
  unenrolled through the whole flow — reusing it for a later happy path
  invalidates both assertions.

## Gotchas

- The daemon publishes `endpoint.json` only after its iroh endpoint binds;
  `pair` fails before that. The harness already waits for the
  `endpoint: <id>` log line — don't add sleeps.
- The gateway's iroh endpoint binds with the production n0 relay/discovery
  config — there's no daemon-side knob to disable it. Only the device side
  disables relays and dials the ticket's direct loopback addresses, so the
  requests themselves stay loopback-local; the daemon's `endpoint:`
  readiness line can still be slow or fail on a fully airgapped machine.
- `--ttl-minutes` accepts fractions; that's what hygiene relies on.
- The daemon and CLI coordinate through file mtimes (reload-on-change). If
  you write a flow that edits those files directly, `fs.utimes` a future
  timestamp like `device-plane.test.ts` does — coarse fs timestamps can hide
  a same-millisecond write.
- Vault ids are minted per run; never hard-code them. Parse them from
  `vault create` / pair-response JSON.

## Where to look

- [lib/harness.mjs](lib/harness.mjs) — `runFlow` + the ctx verbs for the two
  loopback flows. Read before adding a helper there.
- [lib/docker-harness.mjs](lib/docker-harness.mjs) — `runFlow` for
  `cross-network-relay`: network isolation (real, not assumed — see its
  module docstring), native-addon preflight, container lifecycle.
- [lib/device-redeem.mjs](lib/device-redeem.mjs) — the device role, run
  standalone inside the device container by `cross-network-relay`.
- [flows/device-pairing-lifecycle.mjs](flows/device-pairing-lifecycle.mjs) —
  canonical example of the loopback-flow shape.
- [flows/cross-network-relay.mjs](flows/cross-network-relay.mjs) —
  canonical example of the Docker-flow shape.
- [`packages/gateway/src/serve/pairing-store.ts`](../../packages/gateway/src/serve/pairing-store.ts),
  [`enrollment-store.ts`](../../packages/gateway/src/serve/enrollment-store.ts),
  [`../cli/endpoint-host.ts`](../../packages/gateway/src/cli/endpoint-host.ts) —
  the policy under test.
- [`packages/tunnel/src/gateway-endpoint.ts`](../../packages/tunnel/src/gateway-endpoint.ts) —
  the ALPNs and pair protocol frames.
