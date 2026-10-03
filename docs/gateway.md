# The gateway

A **gateway** is any machine the member controls that runs `centraid-gateway`: the laptop at home, a VPS, a NAS. It holds a sealed, restorable copy of each vault the member's phone pairs with it — the vault's snapshots and every original and derivative — and it is the only thing in this product that listens on anything ([#1080](https://github.com/srikanth235/centraid/issues/1080), [R-1080-1](decisions.md#backups-from-first-principles-1080)).

It holds **no key, no plaintext byte, no plaintext hash and no schema**. It can say how many objects it has, how big they are and when they arrived; it cannot say what any of them is, and it cannot recognise a file it already knows, because every name it stores is a keyed hash only the vault's keys can compute ([R-1080-3](decisions.md#backups-from-first-principles-1080)).

**The phone opens a TLS connection straight to it.** No certificate authority, no domain, no relay and no DNS service sits in the path: the gateway mints its own certificate at its first `serve`, the pairing QR carries the certificate's BLAKE3 fingerprint, and the phone pins it. HTTPS rather than anything else because of iOS: the only transfer iOS continues while an app is suspended is a file upload handed to the system's background `URLSession`, and that talks to a URL ([R-1080-2](decisions.md#backups-from-first-principles-1080)).

**The protocol is the rules, not the server.** [`crates/gateway`](../crates/gateway) holds the protocol's `rules` — every route's whole decision, with no I/O, no clock and no randomness — and a conformance suite of 31 named cases that runs against an in-memory state and again over the wire, through the phone's real client, against the real server. The server decides only how bytes arrive; the client is the phone's half.

## The protocol, v2

HTTPS, HTTP/1.1. JSON for small bodies ([R-1029-3](decisions.md#the-phone-is-the-vault--v0-1029-ruled-2026-09-21) stands), raw bytes for objects. A JSON body is capped at 1 MiB, declared rather than inherited from a framework.

| Route | Auth | What it does |
| --- | --- | --- |
| `GET /v2/info` | none | `{gateway_id, protocol: 2, time_ms}`. |
| `POST /v2/pair` | none | `{vault_id, label, kind, …}` → `{token, epoch, gateway_id}`. Three kinds, below. |
| `GET /v2/v/{vault}/head` | bearer | `{name, taken_at_ms, epoch, set_at_ms}`, or `NO_HEAD` carrying the writer epoch. |
| `PUT /v2/v/{vault}/head` | bearer, write | `{name, prev, taken_at_ms}`: a compare-and-set on `prev` that also registers the snapshot. A manifest the gateway does not hold is refused `NOT_FOUND`; a loser is told `HEAD_CONFLICT` with the head as it stands; setting the head that already stands answers it again. |
| `GET /v2/v/{vault}/snapshots` | bearer | `[{name, taken_at_ms, registered_at_ms}]`. |
| `POST /v2/v/{vault}/exists` | bearer | `{names: [...]}`, at most 1,000 → `{missing: [...]}`. |
| `PUT /v2/v/{vault}/o/{name}` | bearer, write | One sealed object, raw, with `Content-Length` and `Content-Digest: blake3=<hex>` → `201` stored or `200` already held with this digest, as `{name, size, digest, stored_at_ms}`. |
| `GET` / `HEAD /v2/v/{vault}/o/{name}` | bearer | The bytes, or one `Range` of them (`206`); a whole answer and a `HEAD` carry the size and the `Content-Digest`. |
| `POST /v2/v/{vault}/bundle` | bearer, write | Many objects in one body of at most 256 MiB → `{stored, already, refused: [{name, code}]}`, each frame answered as its own `PUT` would have been. |
| `POST /v2/v/{vault}/fetch` | bearer | `{names: [...]}`, at most 1,000 → the held objects in the same framing, in the order asked, at most 256 MiB. |
| `GET /v2/v/{vault}/objects?after=<name>&limit=1000` | bearer | `[{name, size, digest, stored_at_ms}]`, sorted by name, at most 1,000 a page; tombstones are left out. |
| `POST /v2/v/{vault}/delete` | bearer, write | `{names: [...]}` → `{deleted, refused}`: a tombstone with a seven-day grace. The head's manifest is refused `HEAD_IN_USE`; a tombstoned manifest deregisters its snapshot; a name never stored, already tombstoned or already purged is `deleted`. |
| `POST /v2/v/{vault}/revoke` | bearer | No body → `{revoked: true}`: the token that calls it is forgotten, so it is `UNAUTHORIZED` on every route after, a second `revoke` included. Any token of the vault may revoke itself, a superseded writer's too; a lost phone's token is revoked by the operator with `pairings revoke <token id>`. |

A **bundle** is `name (64 ascii hex) ‖ digest (64 ascii hex) ‖ u64be(len) ‖ bytes`, frame after frame with nothing between them, and the same framing answers a `fetch` — it is how a phone uploads a snapshot's ranges and a library's thumbnails, and how a restore pulls every derivative, without a round trip per object. Neither end holds a whole bundle in memory.

### Objects

- **An object is one part of one file**, sealed on the phone in `centraid-sealed/2` ([`crates/media/src/sealed.rs`](../crates/media/src/sealed.rs)): at most 64 MiB of plaintext per part, so a `PUT` or a bundle frame over 80 MiB is `TOO_LARGE`. A snapshot's range, a manifest, an original and a thumbnail are the same thing to the gateway.
- **A name is `hex(keyed_hash(K_name, h ‖ u32be(i)))`**: 64 lowercase hex characters derived from the vault's backup key and the BLAKE3 `h` of the file's plaintext. The gateway can neither compute nor invert one, and an unchanged file always seals to the same name.
- **The digest is the transport's, not the content's.** `Content-Digest: blake3=<hex>` is the BLAKE3 of the sealed bytes. The gateway streams a `PUT` into a staged file while it hashes it, refuses `DIGEST_MISMATCH` before anything is recorded, renames the file into place, syncs the directory, and only then answers — so a `201` is a durable acknowledgement. **Acknowledgement is the `PUT`'s success** ([R-1080-7](decisions.md#backups-from-first-principles-1080)).
- **Storage is write-once.** The same name with the same digest is a `200` and moves nothing; the same name with a different digest is `NAME_TAKEN`, and the phone counts that as an acknowledgement too, because a name is a function of the plaintext — the gateway already holds a sealing of exactly those bytes ([R-1080-B4](decisions.md#the-sealed-format-and-the-snapshot-plane-1080-wave-1-lane-b)).
- **A tombstone is a delete with a week to change its mind.** `exists` reports a tombstoned name missing and `objects` leaves it out; a `PUT` of that name stores it again and clears the tombstone; the purge sweep removes its file and its row once the grace has passed. **Until the purge, `GET` and `fetch` still serve its bytes**, so a restore that began from a snapshot keeps reading it while retention drops that snapshot.
- **A damaged object is not served.** The scrub marks what no longer hashes to its digest: `exists` reports it missing so the phone sends it again, `GET` answers `NOT_FOUND`, `fetch` leaves it out, and a `PUT` of the name replaces it.
- **The phone decides what is kept.** Retention — 7 daily, 4 weekly and 6 monthly snapshots — and garbage collection are the phone's, because only the phone can read a manifest; the gateway enforces the two things it can see, the head's manifest and the grace ([R-1080-B5](decisions.md#the-sealed-format-and-the-snapshot-plane-1080-wave-1-lane-b)).
- **There is no quota.** The disk is the member's.

### Tokens, epochs and the fence

`Authorization: Bearer <token>`. A token is 32 random bytes, hex, minted by `POST /v2/pair` and shown once: the gateway keeps only its BLAKE3. The vault in the path must be the token's vault, and an unknown vault answers the same `UNAUTHORIZED`, so neither is an oracle.

Every vault has a **writer epoch**, and a token carries the epoch it was minted at. A write with a token below the vault's writer epoch is refused `MOVED`, carrying the epoch that superseded it; reads still answer. That is the fence (F1): a phone whose vault was restored elsewhere freezes read-only, with what it has still visible, rather than two phones writing one vault's backup.

| `kind` | Admits | Epoch |
| --- | --- | --- |
| `secret` | A vault this gateway has never seen, with the pairing secret from the QR — one use, 24 hours. A known vault is refused `VAULT_KNOWN`. | 1 |
| `read` | Any vault the gateway holds, for a phone that proves it holds the vault's identity key. Its token reads and can never write: what a restoring phone fetches and checks a snapshot with before it claims. | 0 |
| `claim` | A restore or a takeover, signed by the vault's identity key. It must name the writer epoch plus one (`EPOCH_CONFLICT` otherwise) and the head the claimer checked (`HEAD_CONFLICT` otherwise, and nothing moves). | writer + 1 |

A claim's signature is Ed25519 by the vault identity key over a length-prefixed preimage — `"centraid-gateway-claim-v2" ‖ gateway_id ‖ vault_id ‖ u64be(epoch) ‖ head_seen` — so a claim made to one gateway cannot be replayed at another; a read grant signs the same bytes at epoch 0 with no head. **A restore claims only after the snapshot it fetched passed every check**, and the claim names that snapshot's head, so a head that moved in between moves no writer until the new head has been checked too.

### The refusal body

Every refusal is a JSON body, and **a code is never a sentence** — the member-facing wording is the shell's, derived from the code:

```json
{
  "code": "HEAD_CONFLICT",
  "time_ms": 1790000000000,
  "epoch": 3,
  "head": {
    "name": "…",
    "taken_at_ms": 1789990000000,
    "epoch": 3,
    "set_at_ms": 1789990001000
  }
}
```

`time_ms` rides on every refusal, so a phone with a wrong clock can see that it has one. A companion is a value the phone acts on, and a client treats a refusal missing its companion as a malformed answer rather than a default; `"head": null` is a real answer, "there is no head". The code also travels in a `centraid-code` header, so the answer to a `HEAD` — which has no body — still says which refusal it is.

| Code | Status | Companion | Means |
| --- | --- | --- | --- |
| `BAD_REQUEST` | 400 |  | A malformed body, header, name or parameter. |
| `UNAUTHORIZED` | 401 |  | No token, an unknown or foreign token, an unknown vault, a bad signature, or a spent, expired or unknown pairing secret — all one answer. |
| `MOVED` | 409 | `epoch` | A write under a superseded token: freeze read-only. |
| `VAULT_KNOWN` | 409 |  | A pairing secret offered for a vault this gateway already holds. |
| `EPOCH_CONFLICT` | 409 | `epoch`, `head` | A claim that is not the writer epoch plus one. |
| `HEAD_CONFLICT` | 409 | `epoch`, `head` | A compare-and-set lost, or a claim's head is not the head. |
| `NO_HEAD` | 404 | `epoch` | The vault has no head yet. |
| `NOT_FOUND` | 404 | `name` | No such object, or no such route. |
| `DIGEST_MISMATCH` | 400 | `digest` | The bytes do not hash to the declared digest. |
| `NAME_TAKEN` | 409 | `digest` | The name is held with another digest; the phone records it as acknowledged. |
| `TOO_LARGE`, `TOO_MANY` | 413 | `limit` | Over a byte limit or a count limit. |
| `DISK_FULL` | 507 |  | The gateway's disk refused the write; the phone waits and retries. |
| `HEAD_IN_USE` | 409 | `name` | The current head's manifest cannot be deleted. |
| `BAD_RANGE` | 416 | `size` | A `Range` the object cannot satisfy. |
| `INTERNAL` | 500 |  | A store fault. **Not a refusal**: the phone retries it. |

The HTTP status exists only so that a proxy in between behaves. **A refusal is never a 500 and a store fault always is**, and a store fault's detail never reaches the wire — it may name a path — and goes to the operator's log instead.

## The gateway's commands

```sh
centraid-gateway serve    --data-dir ~/centraid-gateway [--bind 0.0.0.0:8443] [--no-mdns]
centraid-gateway pair     --data-dir ~/centraid-gateway [--port 8443]
centraid-gateway pairings --data-dir ~/centraid-gateway [revoke <token id>]
centraid-gateway scrub    --data-dir ~/centraid-gateway
centraid-gateway health   --data-dir ~/centraid-gateway        # or --addr <host:port> --pin <hex>
centraid-gateway install  --data-dir ~/centraid-gateway [--bind 0.0.0.0:8443] [--dry-run]
```

Every verb's `--data-dir` can come from `CENTRAID_GATEWAY_DATA_DIR`, and `serve`'s `--bind` from `CENTRAID_GATEWAY_BIND`.

**It runs with no vault.** `serve` on an empty directory mints the gateway's identity, listens, advertises itself on the LAN, prints its `gateway`, `pin` and `listening` lines, and — while nothing has paired — prints the first pairing QR. Nothing is stored until a phone pairs; `serve` stops on Ctrl-C or `SIGTERM`. `pair`, `pairings` and `scrub` open the same directory beside a running `serve`. `health` asks a running gateway's `GET /v2/info`, trusting the certificate in its own data directory and dialling where its `serve` listens — or another gateway's `--addr` and `--pin` — and exits non-zero when the gateway is down or is not the pinned one. `install` writes a systemd user unit or a launchd agent, creating a missing data directory with mode 0700 first, and prints the command that starts it; **it never enables it**, because a background service that starts because a file was unpacked is a service nobody chose to run. The systemd unit hides the home directory and binds back only the data directory and the binary, so a data directory under `~` works. A `mirror` verb is designed below and not built.

### The certificate

At its first `serve` a gateway mints three files together, each mode 0600: `tls.key` (the private key), `tls.crt` (the certificate) and `gateway.id` (16 random bytes, the id every claim is signed to). **They are the gateway's identity**, and the data directory is what to back up: a gateway that minted afresh would be one every paired phone refuses, and a partial set is refused rather than completed.

- **ECDSA P-256, self-signed.** Apple's TLS stack, which drives the iPhone's background `URLSession`, does not accept an Ed25519 server certificate.
- **The pin is the trust.** No authority signs the certificate and no client checks its name or its dates: at first contact the phone compares BLAKE3 of the certificate's DER against the pin it scanned, and from then on it trusts the certificate's exact bytes — which is also what the iOS background session compares ([R-1080-E3](decisions.md#the-native-shells-backup-half-1080)). The validity runs ten years so that an expiry never makes a member re-pair for nothing they could act on; the SAN carries the gateway id and `localhost` for a stack that insists on a name.
- **TLS 1.3 and 1.2, ALPN `http/1.1` only.**

### Pairing

`centraid-gateway pair` prints the payload and the same text as a half-block QR a phone camera can read straight off the terminal:

```json
{
  "v": 2,
  "gw": "<32 hex>",
  "addrs": ["192.168.1.20:8443", "laptop.local:8443"],
  "pin": "<64 hex>",
  "secret": "<32 hex>",
  "exp_ms": 1790086400000
}
```

`addrs` lists the bound port on every non-loopback interface address, IPv4 first, then the host's `.local` name. The secret admits **one** vault, once, within 24 hours, and the gateway keeps only its hash; a second phone needs a second `pair`.

The phone — **Pair with your laptop** on the More sheet, or **Add a gateway** on the Backup screen — scans or pastes the payload, dials the addresses in order, refuses a certificate whose BLAKE3 is not the pin (`PIN_MISMATCH`, the phone's own code), asks `POST /v2/pair` with the secret, and records the destination in its ledger: the addresses, the certificate's DER, the token, the epoch and the label.

The member compares a **safety number** — 60 digits in 12 groups of 5 — and never a hex string, which people check the first four characters of and stop. Both screens render it with one function, `centraid_identity::safety_number_of_bytes`: the vault's identity key and the certificate's pin, two 32-byte strings sorted by their bytes, BLAKE3 over the pair — no curve point is decoded, so every pin has a number ([W15-D5](decisions.md#w15--the-phones-request-contract-1029), [D-9](decisions.md#the-owners-rulings-of-2026-09-29-1047)). `serve` prints a `safety` line the moment a pairing lands, and `pairings` prints it beside each vault. An empty number means the phone could not compute one, and the phone refuses that pairing rather than draw a blank as a match.

**More than one gateway, from the first day** ([R-1080-8](decisions.md#backups-from-first-principles-1080)). The phone's pairing record is a list: each gateway pairs with its own QR, and the phone writes to whichever it can reach, the LAN one when home. Forgetting a gateway on the phone deletes that destination and its confirmations from the phone's ledger and leaves the gateway's objects as they are.

### Discovery

`serve` advertises `_centraid-gateway._tcp` on the LAN, with TXT `gw` (its id) and `v=2` (`--no-mdns` turns it off). No shell browses for it yet ([Q-1080-D3](decisions.md#backups-from-first-principles-1080)): the pairing payload lists the gateway's `<host>.local` name first, which iOS resolves through Bonjour, so a laptop whose address changed on the same network is still reached by name, and a gateway whose name changed is paired again. The pairing record keeps the addresses the payload listed and the last one that answered, so an upload the OS runs in the background needs no browse. **LAN first** ([R-1080-9](decisions.md#backups-from-first-principles-1080)): v1 reaches a gateway on the LAN or at any address the phone can dial directly — a VPS, a VPN name. Hole punching is not rebuilt, and nothing relays.

### The data directory

| Path | What |
| --- | --- |
| `tls.key`, `tls.crt`, `gateway.id` | The identity, minted together at the first `serve`, mode 0600. |
| `state.db` (with `-wal`, `-shm`) | SQLite: the vaults and their writer epochs, the tokens' and pairing secrets' hashes, the heads and the snapshot history, the object index with each object's digest, size and receipt time, and the tombstones. |
| `objects/<vault>/<name[0..2]>/<name>` | One sealed object per file. |
| `incoming/` | Uploads being staged; emptied when `serve` starts. |
| `serve.json` | The address `serve` last bound, which `pair` and `health` read. |
| `sweeps.json` | When the purge and the scrub last finished. |
| `logs/` | macOS only: the launchd agent's output. |

**These are plain files, and copying the directory copies the gateway.** Stop it, copy the directory anywhere — a VPS, a NAS, a disk in a drawer — and start it there. **What a stolen copy yields**: ciphertext; names nobody can invert; digests of the ciphertext; sizes; times — paired, stored, deleted, heads set, snapshots taken; device labels; each vault's identity **public** key and writer epoch. No plaintext, no plaintext hash and no key that opens anything has a column or a file to arrive in, and the conformance suite's canary scans every byte of the directory, file names included, for each. Tokens and pairing secrets are there only as BLAKE3 of random bytes, so none can be replayed. The directory does hold **the gateway's TLS key**: a thief who can also answer at the gateway's address can impersonate it to its phones — and receive more ciphertext, or lose what they send. After a theft, mint a new identity (move the three identity files aside and `serve`) and pair each phone again.

### The sweeps

Both run inside `serve` and both log **counts only**: a blind store may say how many objects it read and how many it removed, never which.

| Sweep | Cadence | Why that cadence |
| --- | --- | --- |
| **purge** | hourly | Every tombstone past its seven-day grace loses its file and its row. Cheap — an indexed query and an unlink per tombstone — and its job is to make "deleted" mean gone on a timescale a member perceives, so the interval never quietly becomes a second grace. |
| **scrub** | every 90 days | It reads every stored byte to re-hash it against its recorded digest, which on a year of photographs is hours of disk. A damaged object is marked, so `exists` reports it missing and the phone sends it again; nothing deletes a byte the scrub could not vouch for. The on-demand half is the `scrub` verb. |

Each is due one interval after it last **finished**, by the gateway's own clock, as `sweeps.json` records: a restart or a night asleep does not reset the quarter, a gateway that was off for a month sweeps once when it wakes rather than firing a backlog, and a sweep that failed is tried again an hour later.

## Self-hosting

A gateway is the same binary wherever it runs; what changes is the address the phone dials.

| Where | How |
| --- | --- |
| **The laptop at home** | `centraid-gateway serve`, then `centraid-gateway install` for a service that survives a reboot. The phone finds it on the LAN. |
| **A VPS or a NAS** | The same, at an address the phone can reach directly: the machine's public address, or its address on a VPN both ends are on. A port forward or a TCP pass-through in front of it works; a proxy that terminates TLS presents its own certificate, and the phone refuses it, because the phone pins the gateway's. |
| **A container** | `deploy/gateway/Dockerfile`, run on the host's network with a volume at the data directory, which is the whole gateway ([deploy/README.md](../deploy/README.md#the-container)). |

**The backup is as off-site as the member's gateways are.** A laptop-only backup is a local one — fire or theft takes phone and laptop together. A second gateway somewhere else is the off-site copy today, paired from the phone like the first ([Q-1029-6](decisions.md#open-questions-for-the-owner-1029), answered by [R-1080-8](decisions.md#backups-from-first-principles-1080)).

### Mirroring — designed, not built

A gateway will keep a second gateway's copy current by **pulling** from it: an outbound connection from the mirror, which works behind any NAT, reading `snapshots`, `objects` and `fetch` and writing what it lacks. Nothing about it changes what the phone does or what a gateway may read. It is built in a later wave; how a mirror is authorised is an open question for the owner ([decisions.md](decisions.md#open-questions-for-the-owner-1080)).

## Versioning

The protocol's major version is in every path (`/v2`) and in `GET /v2/info`'s `protocol: 2`, and a pairing payload carries `v: 2`. A phone refuses a payload whose `v` it does not read — a QR is read off a screen with no handshake in front of it, so there is no version to negotiate. There is no fallback path and no capability negotiation ([C1](decisions.md#foundational-decisions)); a change that breaks a route or a body is `/v3`.

## Related

- [ARCHITECTURE.md](../ARCHITECTURE.md) — where the gateway sits
- [SECURITY.md](../SECURITY.md) — what a malicious gateway can and cannot do
- [decisions.md](decisions.md#backups-from-first-principles-1080) — the rulings behind all of it
- [recovery/pairing.md](recovery/pairing.md) · [recovery/backup-restore.md](recovery/backup-restore.md)
- [`crates/gateway`](../crates/gateway) — the rules, the server, the client and the conformance suite
