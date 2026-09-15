# `crates/net` — the iroh endpoint

The only crate in the workspace that names an iroh type ([#1020](https://github.com/srikanth235/centraid/issues/1020)). `crates/protocol` is written over a transport trait so that lane D2's `turmoil` simulation can be the primary sync proof; this crate is that trait's production implementation.

## The three ALPNs, and what each lane admits

| ALPN | Lane | Admission |
| --- | --- | --- |
| `centraid/v1/seat` | seat ↔ gateway | The remote EndpointId must be an **enrolled, unrevoked device**. An unenrolled or revoked peer is closed with QUIC application code `401` **before any stream is accepted**, so no byte it sent is ever parsed. Unknown and revoked are the same refusal. |
| `centraid/v1/pair` | ticket redemption | Accepts an unenrolled peer — that is what it is for. The **ticket** is the admission, and it is checked inside one store call that burns it and enrols the device together. |
| `centraid/v1/peer` | gateway ↔ gateway (wave 4) | **Not advertised.** No link policy means the plane is never negotiated; a connection on it is refused. |

Routing is by ALPN alone, never by anything the caller says.

## Relay modes

`EndpointConfig::relay` (`RelayMode`):

- **`Default`** — n0's public relays. The product's default, and the reason a VPS needs no domain, certificate or reverse proxy. The dependency is stated out loud in #1020: hole-punching falls back to relays reached over outbound TCP 443, so the product depends on relay availability.
- **`Custom(url)`** — a self-hosted relay. The answer for a deployment that will not depend on n0: run [`iroh-relay`](https://github.com/n0-computer/iroh) behind your own TLS endpoint and set `--relay <url>`. The gateway names it in every pair ticket it mints, so a seat that scans the QR learns it with no extra configuration.
- **`Disabled`** — direct paths only. A LAN, a loopback test, or a deployment that has decided a relay is an unacceptable third party — and accepts that a symmetric NAT then means no connection at all. With relays off, the ticket's `direct_addrs` are the only way a seat can find the gateway, which is why the field exists (**D-1020-C15**).

## What each failure means

`ConnectError` is a closed set, because a shell that cannot tell "no relay is reachable" from "your gateway is off" renders the same unhelpful sentence for both.

| Variant | What happened | Worth retrying |
| --- | --- | --- |
| `NoRelayReachable` | Relays were configured and none answered; no direct path either. | yes |
| `PeerUnreachable` | The gateway is addressable and did not answer. | yes |
| `Timeout` | The bounded dial budget (`CONNECT_TIMEOUT`, 10 s) elapsed. The product does not know why — and saying "your gateway is off" would be a lie the member acts on. | yes |
| `Unauthorized` | Not an enrolled, unrevoked device. | **no** — the member must pair |
| `VersionWindow` | The handshake refused the peer; an `UpgradeRequired` rides with it. | **no** — someone must update |

Every one of them is also emitted as a `ConnectivityEvent`, which is the only way a shell learns anything about the network.

## `open` never blocks on the network

`Endpoint::spawn` binds the UDP socket and returns. It deliberately does **not** call `iroh::Endpoint::online`, the call that waits for a relay handshake — so the first state every shell sees is `OFFLINE` and connectivity arrives as an event. `tests/pair_and_stream.rs::spawn_returns_without_waiting_for_a_relay` asserts it with a time bound, including for `RelayMode::Default`, which is the mode that could have blocked.

## `idle` and `resume`

**D-1020-C14.** iroh 1.2 has no pause: while an endpoint is bound it keeps a relay connection and its keepalives, which is exactly the battery cost #1020's background rule exists to remove. So `idle()` **closes** the endpoint and `resume()` **re-binds** it. Identity survives because identity is the secret key, not the endpoint object: `Endpoint::id()` is unchanged across the cycle, so every paired seat still recognises the gateway and only the addresses move. A dial while idle is refused rather than silently re-binding — a backgrounded phone that dialled on its own is the thing being prevented.

## Where the durable allowlist is

**Not here.** The natural design is a small SQLite file owned by this crate, with `devices` and `tickets` written in one transaction. #1020's `sql-confinement` invariant puts SQL only under `crates/{ontology,vault,seat,search}` and `crates/apps/kit`, and widening it to fit a design would be weakening a gate. So the design moved instead (**D-1020-C8**): this crate defines the `AllowlistStore` trait and ships `MemoryAllowlist`, and `crates/vault` (lane D1) lands the durable implementation behind the same trait.

The trait is written to stay implementable transactionally: `redeem` burns the ticket and enrols the device in **one call**, so no caller has to sequence two writes and leave a window where a crash half-pairs a phone.

Only a **hash** of a ticket secret is stored. The secret travels in a QR, is read off a screen by a camera, and survives in a photo roll; a gateway that kept it could mint the same pairing twice from its own backup.

## No listening TCP socket

iroh is QUIC over UDP. The only listener this product may ever have is the wave 3 blob door, off by default until the iPhone measurement rules on it (#1020 open question 3). Two things hold it: the xtask `no-listening-socket` rule scans this crate on every gate run, and `crates/centraid`'s test spawns the real binary and asserts through `/proc/net/tcp*` that the process owns no LISTEN socket.
