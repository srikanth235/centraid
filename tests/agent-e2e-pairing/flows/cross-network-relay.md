# cross-network-relay

The pairing ceremony (issue #289) forced over the REAL iroh relay/hole-punch
path — the one seam neither sibling flow in this tier reaches.

## Why this flow exists

`device-pairing-lifecycle` and `pairing-ticket-hygiene` both run the gateway
daemon and the device identity on the SAME host, and both call
`createTunnelClient({ relays: 'disabled' })` (see `lib/harness.mjs`'s
`newDevice()`). That's correct for what they're proving (ceremony semantics,
ticket hygiene) but it means every request in those two flows dials a
loopback address directly — `@number0/iroh`'s QUIC hole-punching and n0
relay fallback never run. Production pairing depends on exactly that code
path (`packages/tunnel/src/client.ts`'s `createTunnelClient()` defaults to
the n0 production preset unless `relays: 'disabled'` is passed, and the
gateway's own endpoint — `packages/gateway/src/cli/endpoint-host.ts` via
`startGatewayEndpoint` — always binds with that preset, no CLI knob to turn
it off). This flow is the one that actually exercises it.

## How it forces the real path

Gateway and device run in **separate Docker containers on separate,
non-interconnected bridge networks** — simulating two independently-NAT'd
hosts without any external VPS or persistent infrastructure:

1. Two `docker network create --driver bridge --ipv6=false` networks
   (`netA` for the gateway, `netB` for the device), each with normal
   internet egress via Docker's own NAT.
2. **Real isolation is enforced explicitly, not assumed — on two separate
   paths.**

   *The docker-internal path.* On a stock Linux Docker Engine (e.g. GitHub
   Actions' `ubuntu-latest`), separate user-defined bridge networks are
   isolated from each other by default. That default does **not** hold
   everywhere — on OrbStack (this repo's local dev Docker), a container on
   `netA` could dial a container on `netB`'s IP directly with no extra
   configuration at all. So `lib/docker-harness.mjs` doesn't trust the
   driver: it inserts explicit `DOCKER-USER` `DROP` rules for the two
   networks' subnets (Docker's documented user-hook chain, evaluated before
   Docker's own rules — safe to add even where the driver already
   isolates).

   *The host-routed path.* Subnet rules alone are **not** sufficient, and
   assuming they were is what made this flow's first run on a GitHub-hosted
   runner select a `isRelay: false` direct path while still reporting
   `ISOLATED`. Both containers NAT out through the host's single public
   NIC, so the public address iroh's endpoint discovers for itself via the
   relay is the **host's own public IP** — a destination that matches
   neither subnet rule. The harness therefore also enumerates every
   non-loopback, non-bridge host IPv4 address at run time (`ip -4 -o addr
   show` inside the privileged helper) and drops traffic to each of them
   from both test subnets. Those rules go into **both** `DOCKER-USER` and
   `INPUT`: a packet a container sends to a host address is either
   hairpinned back toward a container (routed as `FORWARD`, so
   `DOCKER-USER` sees it) or delivered to the host itself (routed as
   `INPUT`, which `DOCKER-USER` never sees). Covering both chains covers
   both outcomes by construction, rather than by assuming which one a given
   host's netfilter path produces. Bridge interfaces (`docker0`, `br-*`,
   `veth*`) are deliberately excluded — they're the containers' next hop for
   legitimate internet egress (apt-get, the n0 relays).

   Both paths are then **proven** with real raw TCP connect attempts before
   any part of the ceremony runs: one to the peer's docker-internal IP, and
   one per host address to a port published from the probe server. If either
   connects, the flow throws immediately rather than running a "relay"
   assertion that would be meaningless on a routable topology.
3. `--ipv6=false` on both networks. This one is load-bearing, discovered by
   running the flow and reading what `paths()` actually reported (see
   below) — OrbStack hands containers a real, globally-routable IPv6
   address (NDP-proxied from the host's own WAN prefix), not a
   Docker-private one. Two containers on IPv4-isolated-but-dual-stack
   networks connected DIRECTLY over that real IPv6 address the first time
   this flow ran, defeating the whole point. Forcing IPv4-only removes
   that escape hatch instead of trying to firewall an address range that
   varies by host and ISP.
4. The gateway daemon (`centraid-gateway serve`) runs in a container on
   `netA`; `vault create` / `pair` / `devices list` run via `docker exec`
   into that same container. `lib/device-redeem.mjs` runs the device role —
   `createTunnelClient()` with **no** `relays: 'disabled'` override — in a
   throwaway container on `netB`.

Everything else about the ceremony (mint → redeem → tunnel → burn) is
identical to `device-pairing-lifecycle`; only the transport changed.

## What's proven vs. what's inferred

- **Network isolation: proven, not inferred — on both paths.** Each
  pre-ceremony TCP probe either times out/errors (blocked) or connects (not
  isolated — the flow throws before running the ceremony at all), and the
  per-target reason is preserved verbatim in the log and verdict rather than
  flattened, so `blocked (timeout)` and `blocked (ECONNREFUSED)` stay
  distinguishable. The single-probe version of this check was
  **tautological** and is why the first CI run passed isolation while a
  direct path was live: it dialed only the peer's docker-internal IP, which
  is exactly and only the traffic the subnet rules block, so it re-tested
  the rule that had just been installed and could not observe the
  host-routed path.
- **Relay-vs-direct: proven, not inferred, and a hard gate on the flow's
  pass/fail.** `@number0/iroh`'s native `Connection` binding exposes
  `paths()` with an `isRelay` flag per candidate path — present on the
  binding all along, just not declared in this repo's hand-written
  `packages/tunnel/src/iroh.ts` shim (extended in this change to declare it:
  `Connection.paths(): Array<PathSnapshot>`, `PathSnapshot.isRelay:
  boolean`). `device-redeem.mjs` reads it right after the tunneled probe
  request, once a path has actually been selected, and reports it in its
  output JSON. It reports **only** the candidate flagged `isSelected` —
  there is deliberately no "first candidate" fallback, since `paths()` lists
  every candidate and an unvalidated direct address among them must never be
  reported as the path that carried data. If nothing is flagged, the device
  reports `path: null` and the flow throws. The flow **asserts** on this
  value: no path selected, or a path selected with `isRelay: false`, both
  fail — this is the one thing the whole Docker-network-isolation harness
  exists to prove, so it can't be allowed to silently not be proven.
- **What this does NOT prove:**
  - That iroh attempted and failed a hole-punch before falling back (vs.
    deciding not to try at all because discovery never found a candidate
    address) — `paths()` gives you the *selected* path's kind, not a
    negotiation trace. `watchPathEvents`/`watchPaths` exist on the binding
    for that level of detail; not used here to keep the flow focused on the
    ceremony, not iroh's internals.
  - That the host-routed probe is byte-identical to the escape it guards
    against. The probe is TCP to a **published** port; the escape observed on
    CI was QUIC/UDP reaching an **unpublished** container through the host's
    NAT. The probe is a strictly harder reachability test (publishing makes
    the target reachable in a way the ceremony's own topology does not), and
    the `DROP` rules it validates carry no `-p` so they apply to UDP equally
    — but "the TCP probe was blocked" is evidence for, not proof of, "no UDP
    path to a host address exists".
  - Anything about hosts whose topology differs again. The failure this flow
    hit was found by CI, not by reasoning; treat a future `isRelay: false`
    as another such discovery rather than as noise.

## A correction worth keeping

An earlier version of this document had the environment reasoning backwards:
it treated stock Linux Docker (GitHub Actions) as the stricter environment
and OrbStack as the leaky one that needed firewalling. The opposite was true
for the failure that mattered. On macOS/OrbStack the "host" is a Linux VM
behind macOS's own NAT, so the relay-observed public address is the Mac's ISP
address, no return path exists, and the relay was the only option — the flow
passed **for the wrong reason**, and every green run before this flow's first
CI execution was that non-proof. On a GitHub-hosted runner, with a real
public NIC on the Docker host, the direct path was live and the flow failed
on its very first honest run. The subnet-only rules and the single-probe
check were never sufficient; they had just never been run somewhere that
could tell.

## Setup gotchas this flow's harness (`lib/docker-harness.mjs`) works around

- **The container needs the LINUX build of `@number0/iroh`'s native addon.**
  The host's `bun install` only resolves `optionalDependencies` for the
  HOST's own platform (e.g. `@number0/iroh-darwin-arm64` on a Mac) — a
  `node:22-bookworm-slim` container needs `@number0/iroh-linux-<arch>-gnu`.
  `ensureNativeAddon()` detects this and fetches the missing package
  additively (`npm pack` + extract into a new `node_modules/@number0/*`
  sibling — nothing is removed, the host's own platform package is
  untouched) if it isn't already present, then verifies
  `require('@centraid/tunnel')` actually loads inside a throwaway
  container before trusting the rest of the flow to it.
- **`docker run` with no `--platform` matches the Docker daemon's host
  architecture**, not necessarily the arch this repo's `bun install`
  targeted. On GitHub Actions `ubuntu-latest` these are the same machine
  (the workflow's own `bun install --frozen-lockfile` runs on the same
  amd64 runner that later runs the containers), so the native addon
  already matches and `ensureNativeAddon()` is a no-op there. On an
  Apple Silicon Mac with OrbStack, the containers default to `linux/arm64`
  while the host's own `bun install` produced `darwin-arm64` — that's the
  case `ensureNativeAddon()` exists for.
- **The gateway daemon shells out to a real `git` binary**
  (`packages/gateway/src/worktree-store/git.ts`) on boot, for the code
  worktree store. `node:22-bookworm-slim` doesn't ship one — the gateway
  container's startup command `apt-get install`s it before starting
  `serve`.

## Steps

1. Build (scoped to `@centraid/gateway` + `@centraid/tunnel`, same as the
   sibling flows) if `dist/` is missing.
2. `ensureNativeAddon()` — see above.
3. Two isolated networks + isolation proof (see above).
4. `vault create --name CrossNet` inside the gateway container.
5. `pair --vault CrossNet` inside the gateway container — parse the
   pasteable ticket.
6. `lib/device-redeem.mjs` in a fresh container on the device network:
   redeem, one tunneled `GET /centraid/_vault/vaults`, then attempt the same
   ticket again to confirm it's burned. Reports `{ paired, endpointId,
   vaultId, vaultName, probeStatus, replayRefused, replayError, path }` as
   one line of JSON on stdout.
7. Assert: paired into the right vault, tunneled probe → 200, replay
   refused, enrollment visible via `devices list` AND `devices.json` from
   the gateway side, AND a path was selected with `isRelay: true`.

## Verdict

PASS iff every assertion in step 7 holds — including the relay-path
confirmation, which is a hard gate, not an observation — AND the
pre-ceremony network isolation probe actually proved isolation (a routable
topology fails the flow before the ceremony runs, rather than producing a
misleading PASS).

## Teardown

Containers, the firewall-rule helper container, the `DOCKER-USER` rules it
inserted, and both networks are removed in a `finally` — best-effort, on
both PASS and FAIL, so a crashed run doesn't leak Docker state. Run-scoped
names (`crypto.randomBytes(4)` suffix) so concurrent runs never collide.
