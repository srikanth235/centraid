# Agent-driven exploratory QA — device pairing

The manual-QA verification loop for the device-pairing ceremony (issue #289),
with three promoted journeys also scheduled nightly. It shares run/verdict
plumbing with [`tests/agent-e2e-mobile/`](../agent-e2e-mobile), but has no Electron or browser —
each flow boots the REAL `centraid-gateway` daemon on a fresh data dir,
drives the REAL admin CLI as separate processes, and plays the device role
with `@centraid/tunnel` over real iroh QUIC.

This is the tier the unit tests can't reach: cross-process seams (daemon
publishes `endpoint.json` → `pair` CLI reads it → device redeems over
`centraid/gw-pair/1` → daemon re-reads `pairing-tickets.json` the CLI wrote)
exercised the way an owner actually performs the ceremony.

## Running a flow

```sh
node tests/agent-e2e-pairing/flows/device-pairing-lifecycle.mjs
node tests/agent-e2e-pairing/flows/pairing-ticket-hygiene.mjs
node tests/agent-e2e-pairing/flows/cross-network-relay.mjs      # needs Docker — see below
```

The first two run gateway + device as plain processes on the same host with
the device's iroh relays explicitly disabled (`lib/harness.mjs`'s
`newDevice()`), so every request dials a loopback address directly — real
enough for ceremony/hygiene semantics, but it never exercises iroh's actual
hole-punch/relay path. `cross-network-relay` is the one that does: it runs
gateway and device in separate Docker containers on separate,
non-interconnected bridge networks (`lib/docker-harness.mjs`), forcing
`@centraid/tunnel`'s real n0-relay default. See
[flows/cross-network-relay.md](flows/cross-network-relay.md) for the full
writeup, including two host-specific gotchas it works around (missing linux
native addon when the host's own `bun install` targeted a different
platform; a Docker network driver — OrbStack, locally — that doesn't
isolate bridge networks by default the way GitHub Actions' `ubuntu-latest`
does).

That's the whole loop for the first two flows. The harness:

1. Runs a scoped build (`turbo run build --filter=@centraid/gateway
   --filter=@centraid/tunnel`, dependency graph included) if
   `packages/gateway/dist` or `packages/tunnel/dist` is missing
   (turbo-cached, cheap when fresh).
2. Creates `runs/<flow>-<timestamp>/workspace/gateway/` as the daemon's
   `--data-dir` — every run is a factory-fresh gateway.
3. Spawns `centraid-gateway serve`, waits for the HTTP listener + iroh
   endpoint identity, streams daemon output to `runs/<runId>/gateway.log`.
4. Runs the flow body with a `ctx` of ceremony verbs (see below).
5. Writes `runs/<runId>/verdict.md` with PASS/FAIL and notes.
6. Closes device endpoints and kills the daemon. On PASS the workspace is
   wiped (verdict + gateway.log stay); on FAIL it's kept so you can inspect
   `devices.json`, `pairing-tickets.json`, `endpoint.json`.

Requirements: a `bun install`ed checkout and Node ≥ 22.5 (`@number0/iroh`
native bindings). The device side runs with iroh relays disabled and dials
the ticket's direct loopback addresses, so the requests themselves need no
relay traffic. The daemon's own endpoint, though, binds with the production
n0 relay/discovery config (there's no daemon-side knob to turn that off), so
a fully airgapped machine may still fail or slow down on the `endpoint:`
readiness line.

## ctx surface

```js
ctx.gateway              // { url, token, endpointId, pid } of the live daemon
ctx.dataDir              // the daemon's --data-dir
ctx.cli(args)            // admin CLI (vault/pair/devices/…); --data-dir appended
ctx.mintTicket(opts)     // pair → { raw, payload }; opts: { vault, ttlMinutes }
ctx.newDevice()          // fresh device identity (auto-closed at teardown)
ctx.request(dev, path)   // one tunneled GET on a fresh connection
ctx.expectTunnelRefused(dev) // assert the QUIC layer refuses this device
ctx.restartGateway()     // SIGTERM + respawn on the same data dir
ctx.readJson(rel)        // parse a JSON file under the data dir
ctx.note(msg)            // observation preserved in verdict.md
```

Flows throw on failure and return `{ pass: true, notes }` on success — same
contract as the other agent-e2e tiers.

`cross-network-relay` (`lib/docker-harness.mjs`) uses a different, Docker-backed
ctx instead — see [flows/cross-network-relay.md](flows/cross-network-relay.md):

```js
ctx.gateway                 // { url, token, endpointId } of the live daemon
ctx.netB                    // the device-side network name
ctx.gatewayExec(args)       // admin CLI, run via `docker exec` into the gateway container
ctx.mintTicket(opts)        // pair → { raw, payload }
ctx.runDevice(opts)         // run lib/device-redeem.mjs in a container on netB;
                             // opts: { ticket, probeTarget } → parsed JSON result
ctx.readGatewayFile(rel)    // parse a JSON file under the gateway container's data dir
ctx.note(msg)               // observation preserved in verdict.md
```

Same throw-on-failure / `{ pass: true, notes }` contract; same verdict.md /
PASS-FAIL console shape. Requires Docker running locally (`docker info` to
check) — no other setup.

## Layout

```
tests/agent-e2e-pairing/
  flows/                ← committed flows (.md intent + .mjs runnable pairs)
  lib/harness.mjs        ← runFlow() + daemon boot/restart/teardown (loopback flows)
  lib/docker-harness.mjs ← runFlow() for cross-network-relay (Docker networks + containers)
  lib/device-redeem.mjs  ← runs INSIDE the device container for cross-network-relay
  runs/                  ← gitignored audit trail per run
```

## Relationship to the scripted tests

| Layer | What it proves |
|---|---|
| `packages/gateway/src/serve/device-plane.test.ts` | store semantics (burn, TTL, reload-on-mtime) |
| `packages/gateway/src/cli/admin.test.ts` | CLI arg parsing + in-process command output |
| `packages/tunnel/src/gateway-endpoint.test.ts` | iroh ALPN protocol against FAKE stores |
| `device-pairing-lifecycle` / `pairing-ticket-hygiene` | the real ceremony across real processes, loopback transport |
| `cross-network-relay` | the same ceremony over the real n0 relay/hole-punch transport |

When a flow here stabilizes into a pure invariant, port it down into one of
the vitest layers and keep this tier for the journey.
