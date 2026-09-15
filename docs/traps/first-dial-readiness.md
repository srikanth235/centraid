# A seat's first dial races two things that look like an unreachable gateway

Paid for once, in [#1025](https://github.com/srikanth235/centraid/issues/1025) S7,
over about two hours of a failure that reproduced every time and pointed at the
wrong half of the product.

The symptom is always the same sentence — **"the gateway did not answer the
pairing request"** — on a gateway that is running, on the same machine, with the
ticket the test just read off its own stdout. The gateway's log says a peer
aborted a QUIC handshake. Neither end is broken.

## 1. `READY` used to be printed before the gateway could accept

`centraid gateway --print-qr` printed `centraid gateway ready` and then the
ticket, and only afterwards opened the vault, opened the byte store and spawned
the accept loop. Every script that waits on that line — which is what the line
is for — got it while the process could not accept a connection. On a seeded
fixture that window was long enough for a seat to dial, wait out its whole
20-second pairing timeout, and be told the gateway did not answer.

**Fixed in the product**: the line is printed after the accept loop exists
([D-1025-S7-7](../decisions.md#slice-s7--one-loop-one-file-one-page-one-report-1025)).
A gateway that says it is ready and then refuses connections is lying to the one
caller that believes it.

**What it looks like if it comes back**: the test's total runtime jumps by
exactly the pairing timeout, and the gateway logs
`a connection was refused … aborted by peer … during the handshake`.

## 2. A relay-mode seat waits on a relay probe before its first dial

`EndpointConfig::default()` is `RelayMode::Default`, and iroh runs a `net_report`
probe against the relay map when an endpoint comes up. On a network with no
route to those relays the probe runs to its own timeout — about sixteen
seconds — and a dial issued behind it expires against the ten-second connect
bound (D-1020-C9) even though the peer is on the same host.

**Fixed in the product**: an EMPTY `relayUrl` on the enrolment record at
`centraid_open` — it was a `"relays": false` flag until #1025 S7-13 and the
shell never set it ([D-1025-S7-16](../decisions.md)) — which is the
other half of `centraid gateway --no-relay`. The shell decides, because the
shell is what read the ticket: a ticket that names no relay is a deployment that
has none.

**What it looks like**: `WARN iroh::net_report … reportgen timed out` beside
`WARN centraid_seat_link::seat: the pairing dial failed error=Timeout(10s)`. The
seat's own logs are the only place this is visible, and a test process installs
no `tracing` subscriber by default — `crates/centraid/tests/walking_skeleton.rs`
installs one for exactly this reason, and without it the failure reads as a
sentence with nothing behind it.

## 3. And a freshly bound endpoint is still discovering its own addresses

Even relay-free, `centraid_open` returns as soon as the endpoint is spawned —
which is the contract, and the reason a shell's first screen never waits on a
network — and iroh then enumerates this host's interfaces in the background. A
dial issued in the middle of that takes seconds longer than one issued after it.

On a phone the gap is filled by a member reading a screen and tapping a button.
**In a test nothing fills it**, so `walking_skeleton.rs` waits
`ENDPOINT_WARMUP` (3 s) after opening the seat and before pairing, and asserts
nothing about the duration: it is a property of the host's networking, not of
this product, and a test that pinned it would be pinning somebody else's number.

## The order to check them in

1. Is anything else listening? A gateway left running by a previous manual run
   costs a pairing and looks exactly like this. `pkill -f "centraid gateway"`.
2. Does the CLI pair? `centraid seat pair <ticket>` against the same gateway,
   immediately after the ticket appears. If that works and a test does not, it
   is 2 or 3 and not the gateway.
3. Turn the seat's logs on. `RUST_LOG=iroh=debug,centraid_seat_link=debug`, and
   read the `connecting … ip_addresses=[…]` line: it says what the seat is
   dialling and the gap to the next line says how long it waited.
