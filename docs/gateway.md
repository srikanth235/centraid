# The gateway

A **gateway** is a blind store for one or more vaults' sealed backup objects. In v0 it is the
member's own laptop running `centraid-gateway`, and it is the only thing in this product that
listens on anything ([#1029](https://github.com/srikanth235/centraid/issues/1029) and the [scope
amendment of 2026-09-21](https://github.com/srikanth235/centraid/issues/1029#issuecomment-5755559795)).

It holds **no key, no plaintext byte and no schema**. It can tell you how many objects it has, how
big they are and when they arrived; it cannot tell you what any of them is.

**The deployment is not the reference implementation.** The protocol is
[`crates/gateway-core`](../crates/gateway-core/README.md) — rules with no I/O, no clock and no
ambient randomness — and what "conforming" means is its conformance suite.
[`crates/gateway-server`](../crates/gateway-server/README.md) is one adapter over those rules and
decides only how bytes arrive.

## The protocol

Seven routes, all under `/v1`.

| Route | What it does |
| --- | --- |
| `GET  /v1/health` | Answers on an empty server, before anybody has redeemed an invite, because a phone negotiates a version before it has an account. |
| `POST /v1/vaults/{vault}/admit` | Redeems an invite and admits a device for a vault. |
| `POST /v1/vaults/{vault}/lease` | Claims the writer lease, at an epoch. Claimed **once**, by pair or by restore — never per drain. |
| `POST /v1/vaults/{vault}/declare` | Declares the objects a pass is about to upload and gets an upload target for each. |
| `POST /v1/vaults/{vault}/commit` | Moves the manifest head under a `prev_head` compare-and-set, and advances the acked txid range. |
| `POST /v1/vaults/{vault}/delete` | Asks for objects to be tombstoned, subject to the retention floor and the guards. |
| `PUT  /v1/objects/{vault}/{name}` · `GET /v1/objects/{vault}/{name}` | The bytes. The server streams them into and out of the store; it does not open them and cannot. |

Bodies are **JSON** ([R-1029-3](decisions.md#the-phone-is-the-vault--v0-1029-ruled-2026-09-21)); the
`.proto` files under [`crates/api-proto`](../crates/api-proto/README.md) remain the schema of record
for the shapes. A request body other than an object `PUT` is capped at 1 MiB, declared rather than
inherited from the framework; an object `PUT` is capped at `MAX_OBJECT_BYTES`, which is
`gateway-core`'s own number and not a second one.

### Signing

Every request is signed by the phone's **device key** over a length-prefixed preimage of the
method, the path, a body digest, the protocol version and a timestamp, under the domain separator
`centraid-gateway-request-v1`. Four headers carry it:

| Header | What |
| --- | --- |
| `centraid-certificate` | The device certificate, hex — 136 bytes, "the vault identity key K certifies device D at epoch E". |
| `centraid-signature` | The Ed25519 signature over the preimage, hex. |
| `centraid-timestamp` | The client's clock, milliseconds since the Unix epoch. |
| `centraid-protocol` | The protocol version, **inside** the signature so a middlebox cannot rewrite it. |

The preimage is assembled once, in `gateway-core`, from typed fields — never from header text,
because header casing and joining differ between adapters and a phone that signs one shape and is
verified against another fails for a reason nobody can read in a log. Every field is
length-prefixed. A lease claim is **additionally** signed by the vault's identity key.

The replay window is five minutes each way. Outside it the server answers `GATEWAY_CLOCK_SKEW` with
its own time and the window, and the phone re-signs **once**.

The server holds only public keys. It never learns an email address, a phone number or a name.

### The object rules

- An object is at most **16 MiB**. A bigger file is a list of objects (F6). Every kind — `BASE`,
  `SEGMENT`, `MANIFEST`, `BLOB`, `PACK` — is the same thing with a different label.
- **A name is the BLAKE3 of its bytes.** The gateway hashes what it stores and refuses
  `name != blake3(bytes)` before it acks. There is no attested checksum and no second hash.
- **Storage is write-once.** Presigning a name that is already committed is refused; re-declaring a
  committed object is a no-op, which is what makes a re-run of an interrupted pass free.
- **The head moves under a compare-and-set.** `commit` carries `prev_head` and `manifest_head`; a
  loser is told `GATEWAY_HEAD_CONFLICT` with the head as it stands now. That is the fence, and it is
  the reason two phones racing a takeover produce one winner and one phone that is told.
- **One manifest entry per uploaded batch**, not one per generation
  ([W15-D4](decisions.md#w15--the-phones-request-contract-1029)) — so a background window that ends
  mid-pass still advances the acked txid instead of claiming nothing.
- **Sizes are Padmé-padded.** That bounds the compression size-class leak; it does not remove it.
- **Tenancy is enforced on the path.** The vault in the URL must be the vault the caller's
  certificate names, so one household member cannot read, head or delete another's objects.

### The refusal body

Every refusal is a JSON body, and **a code is never a sentence** — the member-facing wording is
derived from the code by the shell:

```json
{ "code": "GATEWAY_HEAD_CONFLICT", "serverTimeMs": 1758432000000, "currentHead": "…" }
```

`serverTimeMs` rides on **every** body, after any refusal, because a phone with a wrong clock has to
be able to re-sign after all of them. A handful of codes carry a companion: `moved` (which epoch
superseded this device, and when), `protocol` (both ends of the version comparison), `skewWindowMs`,
`currentHead` — where an empty string is a real answer, "there is no head" — `quota` (ceiling, spent,
wanted) and the lease's two epochs.

The HTTP status is only so that a proxy in between behaves. **A refusal is never a 500 and a store
fault always is**: the phone retries the second and not the first. A store fault's detail never
reaches the wire — it may name a path — and goes to the operator's log instead.

## The laptop

```sh
centraid-gateway serve   --data-dir ~/vault
centraid-gateway invite  --data-dir ~/vault --quota-gib 64
centraid-gateway invites --data-dir ~/vault
centraid-gateway scrub   --data-dir ~/vault [--repair]
centraid-gateway health  --url http://127.0.0.1:8443
centraid-gateway install --data-dir ~/vault [--dry-run]
```

**It runs with no vault and no keys.** `serve` on an empty directory creates a state file, listens,
and serves nothing to nobody until an invite is redeemed.

### `node.key`

`<data-dir>/node.key` is the iroh secret key, minted once on first `serve` and mode 0600. **It is the
laptop's identity**: the id a phone scanned off the pairing QR is this key's public half, and a
laptop that minted a fresh one on restart would be a laptop every paired phone stops being able to
find. Back it up with the data directory; losing it means every phone re-pairs.

### Pairing

`centraid-gateway invite` prints three things: the invite code, a `pair` payload, and that payload as
a **half-block Unicode QR** a phone camera can read straight off the terminal. The payload carries
the laptop's endpoint id and the invite. The phone scans it, admits itself, claims the lease and
stores the endpoint id in `backup/laptop.json` beside its vault —
[device-local derived state, deliberately not in the vault](decisions.md#w15--the-phones-request-contract-1029).

The member compares a **safety number** — 60 digits in 12 groups of 5, BLAKE3 over the two identity
keys sorted by their bytes — and never a hex endpoint id, which is a string people check the first
four characters of and stop ([W15-D5](decisions.md#w15--the-phones-request-contract-1029)).

An invite is one-use and expires; `centraid-gateway invites` lists what became of each.

### The store

`<data-dir>` holds the state file (SQLite: the object index, the manifest heads, the leases, the
invites and the quotas) and the object store on the filesystem. The S3/SigV4 store was struck with
the hosted tier; the laptop's store is the filesystem.

### The sweeps

Both run inside `serve`, both are configurable, and both log **counts only** — a blind store may say
how many objects it read and how many it removed, and never which.

| Sweep | Cadence | Why that cadence |
| --- | --- | --- |
| **purge** | hourly (`purgeEverySeconds`, `0` disables) | Cheap: a state query per vault and an unlink per purgeable object. Its job is to make "delete" mean something on a timescale a member can perceive, so the interval must not silently become a second grace period. |
| **scrub** | quarterly (`scrubEverySeconds`, `0` disables) | It **reads every stored byte** to re-hash it. On a year of bases that is hours of disk, and running it often would make a backup server a machine you notice. The on-demand half is the CLI verb. |

They are timers against the last completed sweep, not a wall-clock cron: a laptop sleeps, moves
between networks and is closed at night, and a wall-clock schedule would either fire a storm on wake
or skip a quarter because the machine was shut at the wrong moment. A laptop that was off for a
month sweeps once when it comes back.

### Retention

The **base** is the unit of retention (F10). The default floor is 7 daily, 4 weekly and 6 monthly
bases, with a 7-day grace period before a tombstoned object's bytes become purgeable. Two guards sit
over deletes: a new base whose total padded size is below half its predecessor's is refused, and
client-directed base tombstones are rate-limited — a stolen phone cannot outrun a rate limit (F4).
The row-census version of the same rule is the **phone-side** warning, where the census is readable.

## Self-hosting

**iroh is the default carrier, and it is the reason there is nothing to set up.** The API is carried
as HTTP/1.1 over one iroh bidirectional stream under ALPN `centraid-gateway/1`, so a laptop behind
NAT needs no port forwarding, no domain and no certificate. The router cannot tell which carrier a
request arrived on — nothing on the wire changes.

Iroh gives LAN-direct, hole-punched and relayed paths with one client. n0's relay and DNS server are
the defaults and both are configurable; `iroh-dns-server` is self-hostable, and pointing at your own
is a config change on both ends rather than a different protocol.

For a self-hoster who **does** have a domain, the TCP carrier stays:

| Setup | How |
| --- | --- |
| Behind a reverse proxy, a Cloudflare Tunnel or a Tailscale Funnel | `--bind` and `--origin`, with TLS terminated in front. `--origin` is the one thing that must be right: proxied upload targets are built from it. |
| Certificate obtained by this process | The ACME arm. `acme.rs` is not deleted. |
| Container | [`deploy/gateway-server/Dockerfile`](../deploy/gateway-server/Dockerfile); `CENTRAID_GATEWAY_DATA_DIR` and `CENTRAID_GATEWAY_ORIGIN` are read from the environment because a `CMD` cannot know the household's hostname. The health check is `centraid-gateway health`. |
| OS service | `centraid-gateway install` writes a systemd unit or a launchd agent and prints the command that enables it. **It never enables it**: a background service that starts because a file was unpacked is a service nobody chose to run. |

**A laptop-only backup is a local backup.** Fire or theft takes phone and laptop together. v0 accepts
this; an off-site copy is [Q-1029-6](decisions.md#open-questions-for-the-owner-1029).

## Versioning

Two versions, and they are not the same number.

- **The carrier**, `centraid-gateway/1`. The `/1` is the ALPN's own version, declared once in
  `centraid-gateway-core` and imported by both ends. It changes when the *framing* changes, which is
  rarely.
- **The protocol**, `PROTOCOL_MIN` and `PROTOCOL_MAX` in `centraid-gateway-core`, both `1` today.
  These are negotiated **inside** the requests the carrier carries, and they are what moves when a
  route or a body changes.

A request outside the server's range is refused with `VERSION_WINDOW`, carrying **both** ends of the
comparison — because "the server is too old" and "the phone is too old" are the same comparison seen
from two ends, and the phone must be able to say which one happened. There is no fallback path and no
capability negotiation beyond the range ([C1](decisions.md#foundational-decisions)); the client shows
an update wall.

The pkarr record a vault's identity key publishes carries the laptop's `endpoint=` and is named
`_centraid2` — bumped once from `_centraid` when the endpoint id arrived and the mailbox entry left.

## Related

- [ARCHITECTURE.md](../ARCHITECTURE.md) — where the gateway sits
- [SECURITY.md](../SECURITY.md) — what a malicious gateway can do, and what n0 sees
- [decisions.md](decisions.md#the-phone-is-the-vault--v0-1029-ruled-2026-09-21) — the rulings behind all of it
- [recovery/pairing.md](recovery/pairing.md) · [recovery/backup-restore.md](recovery/backup-restore.md)
- [`crates/gateway-core/README.md`](../crates/gateway-core/README.md) — the rules and the conformance suite
