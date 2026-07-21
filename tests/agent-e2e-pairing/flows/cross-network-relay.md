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
2. **Real isolation is enforced explicitly, not assumed — on three separate
   fronts.**

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

   *The port-class front.* Address rules — both of the above — were still
   not sufficient, and the way they failed is worth stating precisely,
   because it is not a bug in the rules but a limit on what any
   address-based rule can express. On an Azure-hosted GitHub runner (CI run
   29733737906) the flow reported `ISOLATED` and then selected a **direct**
   path to `20.116.79.56:64512`. `hostAddresses()` had enumerated only
   `10.1.1.124`, the runner's **private** NIC. `20.116.79.56` is the
   runner's **public, NAT-mapped** address — the one the n0 relay observes
   and hands back as the peer's direct candidate — and Azure performs that
   translation **upstream**, so the address appears on no local interface.
   `ip -4 -o addr show` structurally cannot see it, no `DROP` rule ever
   covered it, and the isolation probe passed while the escape hatch stayed
   wide open.

   Discovering that address would mean an external lookup service, a
   different answer on every runner, and a dependency that can change under
   us — no foundation for a hard gate. So the harness stopped trying to name
   the address and blocks by **transport** instead, which is
   host-independent — and this works because of an asymmetry in iroh that is
   worth stating with its sources, since the intuitive guess about it is
   wrong:

   - Every **direct** path iroh can build is **QUIC over UDP**, to an
     ephemeral high port (`64512` in the failure above).
   - The **relay-carried data path is not UDP at all.** In `iroh` /
     `iroh-relay` 1.0.2 — the versions all three of this repo's lockfiles
     pin — it is a WebSocket over TLS over **TCP 443**:
     `iroh-relay/src/client.rs` rewrites the relay URL's `https` scheme to
     `wss` and dials via `TcpStream::connect`, and the production relay URLs
     (`https://use1-1.relay.n0.iroh.link`, …) carry no explicit port. There
     is no QUIC anywhere in the relay data transport.

   So the policy is simply: **`DROP` all UDP out of both test subnets except
   `--dport 53`** (DNS, or the containers can't resolve the relay hostnames
   at all). TCP is untouched, so `apt-get` and — crucially — the relay
   itself keep working. This is why the change **degrades correctly**: the
   rules are incapable of breaking the connection, only its *directness*. A
   run that can't reach the relay is failing for some other reason.

   An earlier revision of this harness allowed `--dport 443` on UDP too, on
   the assumption that "QUIC" implied it. That was a hole with no purpose,
   and it has been removed — a firewall comment asserting something false
   about the transport is worse than no comment.

   **QAD on UDP 7842 is blocked on purpose.** The one thing the relay does
   speak over UDP is QUIC address discovery, on `DEFAULT_RELAY_QUIC_PORT =
   7842` (`iroh-relay/src/defaults.rs`), driven by the `QadIpv4`/`QadIpv6`
   probes in `net_report/reportgen.rs`. It is deliberately *not* allowed:
   QAD is the mechanism by which a peer learns its own public NAT-mapped
   address — precisely the mechanism that produced the `20.116.79.56`
   candidate that defeated the previous fix. Blocking it attacks the failure
   at its source rather than only blocking the dial it leads to. (STUN/3478
   does not appear here either; it is gone in iroh 1.0.x, and the surviving
   `re_stun` identifiers are vestigial names that now drive QAD.)

   Rule **order** is load-bearing and silently invertible: `iptables -I`
   inserts at position 1, so the last rule inserted is the first evaluated.
   The catch-all `DROP` is therefore inserted *before* its DNS `ACCEPT`
   exception, and the whole port-class block is inserted *before* the two
   address blocks — so the address `DROP`s stay above the DNS `ACCEPT`s and
   an address covered by the host rules stays covered. The probe's own
   `--sport` `ACCEPT` is the one rule that must outrank *everything*, so it
   is inserted after all three blocks; see the fourth correction below. Like
   the host-address rules, the port-class rules go into **both**
   `DOCKER-USER` and `INPUT`, for the same two-fates reason.

   Resulting evaluation order per chain, top-first: `ACCEPT -p udp --sport
   9999` (probe-scoped, gone before the ceremony) → host-address `DROP`s →
   peer-subnet `DROP`s → `ACCEPT -p udp --dport 53` → `DROP -p udp`.

   All three fronts are then **proven** before any part of the ceremony
   runs, with probes that dial each path rather than re-testing a rule just
   installed: raw TCP connects to the peer's docker-internal IP and to each
   host address at a port published from the probe server, plus the **UDP**
   counterparts of both against a UDP echo server on the same probe
   container. If anything connects or replies, the flow throws immediately
   rather than running a "relay" assertion that would be meaningless on a
   routable topology.

   The UDP probes are **self-validating**, which matters more than it
   sounds: UDP has no handshake, so "blocked" and "the echo server never
   came up" are the same observation — silence — and a silently-broken UDP
   probe would report `ISOLATED` for entirely the wrong reason, putting us
   back exactly where the Azure run left us. So a **control** runs first,
   from the privileged host-network helper: it sends the same datagrams to
   the same two target classes and **requires** replies. Only once the
   server has demonstrably answered is silence from `netB` treated as
   evidence of blocking; if the control is silent, the harness throws with
   that reason rather than claiming isolation it hasn't earned. One narrow
   `ACCEPT` exists purely to make this possible — the echo server sits on
   `netA`, so its *reply* datagrams originate from a test subnet and our own
   `DROP` rules would eat them; the exception is matched on `--sport`
   (the probe server's fixed port), so it only ever lets the echo server
   answer.

   That exception is inserted **last of all**, after both address blocks, so
   it evaluates **first** — above the host-address `DROP`s, not just above the
   port-class one. That ordering is the fourth correction in this file and it
   is written up at the end. Briefly: the control dials a *host* address, so
   the reply it is waiting for carries `src=<test subnet>` and `dst=<that host
   address>`, which is precisely what the host-address `DROP` matches. Placing
   the exception above only the port-class block leaves the reply blocked. It
   does not weaken the test, because every probe *request* leaves from an
   ephemeral source port and so matches no `--sport 9999` rule: the requests
   still fall through to the `DROP`s they exist to exercise, and only the echo
   server's answers are exempt.

   **That exception does not outlive the probe.** It is a UDP hole, and
   leaving it open during the ceremony would mean the flow's one real
   assertion ran with a known exception in the very block it exists to prove
   closed. The argument that it's harmless anyway — a peer's *initiating*
   datagram is still dropped, so no flow can form one-directionally — is
   probably correct, but "probably correct" is the wrong standard here and
   the cost of not relying on it is two `iptables -D` calls. So the rules are
   deleted as soon as the probe returns, and their removal is **asserted**,
   not assumed: `iptables -S DOCKER-USER` / `INPUT` are read back and any
   surviving `--sport` `ACCEPT` scoped to this run's subnets fails the flow.
   The verdict records that the ceremony ran with the port-class block fully
   closed. Teardown bookkeeping stays single-pathed — each rule is spliced
   out of the harness's teardown queue only *after* its `-D` succeeds, so the
   failure path removes them via the normal `finally` and a success can't
   produce a double delete.

   Deliberately **not** done: re-running a UDP probe after the removal to
   re-confirm blocking. It would prove nothing. Taking the `--sport` `ACCEPT`
   away also removes the echo server's ability to reply at all, so silence
   afterwards is guaranteed by construction whether or not the `DROP` is
   working — the probe stops being self-validating at exactly the moment you'd
   want to trust it. Reading the rule set back is both cheaper and actually
   falsifiable.
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

- **Network isolation: proven, not inferred — on every front.** Each
  pre-ceremony TCP probe either times out/errors (blocked) or connects (not
  isolated — the flow throws before running the ceremony at all); each UDP
  probe either gets its datagram echoed back (not isolated) or stays silent
  after a control run has established that a reply was possible at all. The
  per-target reason is preserved verbatim in the log and verdict rather than
  flattened, so `blocked (timeout)`, `blocked (ECONNREFUSED)` and `blocked
  (no reply in 4000ms)` stay distinguishable and a leak names **which** path
  leaked. The single-probe version of this check was **tautological** and is
  why the first CI run passed isolation while a direct path was live: it
  dialed only the peer's docker-internal IP, which is exactly and only the
  traffic the subnet rules block, so it re-tested the rule that had just
  been installed and could not observe the host-routed path.
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
  - That any probe is byte-identical to the escape it guards against. The
    probes reach a **published** port; the escape observed on CI was QUIC/UDP
    reaching an **unpublished** container through the host's NAT. Publishing
    makes the target reachable in a way the ceremony's own topology does not,
    so these are strictly harder reachability tests — but harder is not
    identical.
  - That the transport split holds forever. The port-class front rests on one
    claim about iroh — direct paths are UDP, the relay's data path is TCP —
    read out of the `iroh-relay` 1.0.2 sources for the version this repo
    pins, **not** observed against a running relay. If a future iroh carries
    relayed data over QUIC, these rules would break the connection outright
    instead of steering it. That failure is loud (the ceremony can't
    complete) rather than quiet (a dishonest PASS), which is the right way
    round, but it would look like an unrelated breakage, so: if this flow
    starts failing to connect at all after an iroh bump, check the relay
    transport before anything else.
  - That the public NAT-mapped address is *unblockable* — only that it is
    **unenumerable** from the host, which is why isolation is enforced by
    port class rather than by address.
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

The second correction is narrower and sharper. The fix for the above —
enumerate the host's addresses and drop traffic to each — was written as
though "the host's public IP" were something the host knows. On an
Azure-hosted runner it is not: the runner sees only its private NIC
(`10.1.1.124`), while the address the relay observes and advertises
(`20.116.79.56`) is assigned by NAT somewhere upstream and appears on no
interface the runner can enumerate. The rule set was not mis-ordered or
mis-applied; it was asking a question the host cannot answer. That is the
whole reason this harness now blocks by transport as well: the transport of a
direct path is a property of the protocol, which every host can observe,
rather than a property of the network topology, which some hosts cannot.
Both address fronts are kept anyway — they're cheap, they're correct where
they apply, and each one narrows the space the port-class rules have to hold
alone.

There is a third correction embedded in the second, and it is the same
mistake in a smaller costume. The first attempt at the transport front
allowed UDP 443 alongside DNS, reasoning "the relay is QUIC, QUIC is UDP,
HTTPS is 443." Every step of that is plausible and the conclusion is wrong:
the relay's data path is a TCP WebSocket, and the only UDP it speaks is
address discovery on 7842 — which is the one thing we most want blocked.
That guess would have left an open UDP hole justified by a comment asserting
something false about the transport, which is strictly worse than no comment,
because the next person would have had no reason to re-check it. The rule set
is now smaller *and* stronger than the guess: allow DNS, drop the rest.

The fourth correction is the one the control run caught itself, which is the
only cheerful thing about it. CI run 29743139605 (job
`pairing-cross-network-relay`) threw *before* the ceremony with "UDP isolation
probe is not trustworthy": the control got no reply from
`udp host-routed 10.1.0.201:46321`, while its docker-internal leg answered
normally. The probe refused to report isolation it had not established —
exactly the failure mode the control exists to produce instead of a false
`ISOLATED` — but the reason was not a broken echo server. It was our own rule
set eating the **reply**.

The error message carried the mistaken premise in its own text: the control
runs "from the host network, which no isolation rule matches." That is true of
the outbound datagram and false of the return one. The echo server lives on
`netA`, so its reply leaves with `src=<subnetA>`, `sport=9999` and `dst=<the
host address the control dialed>` — and `-s <subnetA> -d <hostAddr> -j DROP` is
exactly the host-address rule, present in both `DOCKER-USER` and `INPUT`.
Because the `--sport 9999` `ACCEPT` had been inserted inside the port-class
block, and the host-address block is inserted *after* it (hence *above* it),
the `DROP` won. The `--sport` exception had only ever protected the reply from
the port-class `DROP`; it never protected it from the host-address one. The
docker-internal leg passing in the same run is the tell — its reply goes to the
bridge address `172.x.0.1`, which the host-address enumeration deliberately
skips, so no rule named it.

The fix is ordering, not policy: the probe exception is now inserted last, so
it sits at the top of both chains and outranks the host-address `DROP`. Nothing
the probe tests is weakened, because the exemption is `--sport`-scoped and every
probe *request* leaves from an ephemeral port (Linux 32768–60999, never 9999).
The `netB` host-routed UDP probe is therefore still dropped by the host-address
rule, the `netB` docker-internal one still by the subnet rule, both TCP probes
are untouched (`-p udp`), and the exemption is still retired — and its removal
still read back out of `iptables -S` — before the ceremony starts.

The `ESTABLISHED,RELATED` `ACCEPT` that would also have fixed this was
considered and rejected: it admits return traffic for *any* connection rather
than for one named port, which is a materially larger hole in the block this
flow exists to prove closed, and it buys nothing the reordering doesn't. So was
dropping the host-routed UDP probe and keeping only the docker-internal one —
that trades away the strictly harder published-port test, which is the front
that caught the original escape.

Worth noting, because the asymmetry looks suspicious: the TCP host-routed probe
has never had this problem, and not by luck. There is no TCP control run. The
only TCP probe dials **from `netB`**, and its request is dropped on the way out,
so no reply is ever generated for a host-address rule to eat; and had one been
generated, its destination would be a container in `netB`, not a host address,
so the host-address rule would not have matched it anyway. The reply-path
hazard is specific to the host-originated control leg, which only UDP has.

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

Containers, the firewall-rule helper container, every `DOCKER-USER` and
`INPUT` rule it inserted (each one registered for teardown the moment its own
insert succeeds, so a throw partway through the rule sets still leaks
nothing), and both networks are removed in a `finally` — best-effort, on
both PASS and FAIL, so a crashed run doesn't leak Docker state. Run-scoped
names (`crypto.randomBytes(4)` suffix) so concurrent runs never collide.
