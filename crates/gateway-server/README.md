# `centraid-gateway-server` — the gateway anyone can run

One protocol, two deployments (#1029 §3). This is the second one: a single
binary a household runs on a box in a cupboard, passing the same conformance
suite the hosted Cloudflare adapter will. **The phone cannot tell which one it
is talking to**, and everything below exists to keep that true.

## Run it

```sh
centraid-gateway serve --data-dir ~/vault --origin https://vault.example.org
```

That is the whole first run. It creates `~/vault/gateway.sqlite` and
`~/vault/objects/`, listens on `0.0.0.0:8443`, and serves nothing to nobody —
**there is no vault and there are no keys**, and there will not be until
somebody redeems an invite.

```sh
centraid-gateway invite  --data-dir ~/vault --quota-gib 64   # read this aloud
centraid-gateway invites --data-dir ~/vault                  # what became of them
centraid-gateway scrub   --data-dir ~/vault [--repair]       # re-hash, no key
centraid-gateway health  --url http://127.0.0.1:8443         # the image health check
centraid-gateway install --data-dir ~/vault --origin … [--dry-run]
```

## Getting it reachable without opening a port

`--origin` is the name a phone dials, and it is the one setting that has to be
right: proxied upload targets are built from it. Three shapes, none of which
needs an inbound port on a home router:

| Shape | What holds the certificate | `tls` |
| --- | --- | --- |
| Cloudflare Tunnel (`cloudflared`) | Cloudflare | `terminated` (default) |
| Tailscale Funnel (`tailscale funnel 8443`) | Tailscale | `terminated` (default) |
| A reverse proxy you already run (Caddy, nginx) | that proxy | `terminated` (default) |
| This server, on a public 443 | this server, by ACME | `acme` |

The ACME arm uses **TLS-ALPN-01**, answered on the 443 it is already listening
on: no port 80, and no DNS API token. Run a first order against Let's Encrypt's
staging directory (`"staging": true`) — production's rate limit is per domain
per week and a wrong `origin` burns it quietly.

## Where the bytes go

Two stores, and an optional second one beside either:

- **a directory** (the default) — a home box has one disk;
- **anything S3-compatible** — MinIO, Backblaze B2, Wasabi, Garage, or R2
  through its S3 endpoint.

**Bytes are proxied by default and presigning is the opt-in**, which is the
reverse of the hosted adapter. A self-hoster's bucket is usually not reachable
from a phone on cellular: a presigned `http://minio.lan:9000/…` handed out over
a tunnel is a transfer that hangs and then times out. Turn `presign` on when the
bucket really is public and you want the bytes off your uplink.

The optional `mirror` is a second store written on every upload. It is what
makes `scrub --repair` able to do anything: the scrub reports what no longer
hashes to its name, and the repair copies the mirror's copy back **only if that
copy hashes correctly**.

## The checksum mode is a property of the store, not of this server

B2 and MinIO do not attest the same checksum headers, and R2 records one only
when the client sent it. So:

- `attest` — the store attests, the gateway never reads the bytes. Cheap, and
  the mode the hosted adapter runs in. The default for an S3 store.
- `read-and-hash` — the gateway reads and hashes. Costs a read per commit and
  catches one more thing: bytes that do not hash to the name they are filed
  under. The default for a directory, which attests nothing on its own.

Point this at a store that does not attest while configured for `attest` and
commits are refused with `GATEWAY_CHECKSUM_MISSING`. That is the rule working;
switch to `read-and-hash`.

## Household tenancy, by invite (Q13)

`centraid-gateway invite` mints a bearer secret the owner reads out once. The
server stores its **BLAKE3 and never the secret**, so a stolen state file is not
a set of working invitations, and redemption is a conditional `UPDATE` so two
phones racing on one invite end with one vault. A redeemed vault is an ordinary
tenant that every rule already knows how to judge — `centraid-gateway-core` is
multi-tenant already, and there is no "multi-tenant mode" here.

**Append-only is off by default (Q24).** Turning it on means devices cannot
delete anything at all and the owner prunes from the admin path; a household
that never heard of it must not discover it as a backup that only grows.

## What is in this crate, and what is deliberately not

**No rule is here.** The checksum comparison in both modes, the refusal to
presign a committed name, the manifest compare-and-set, delayed deletes, the
retention floor, the size guard, the delete rate limit, plan lapse, blind
scrubbing and capability scope are all `crates/gateway-core`'s, reached through
`Gateway`. If the conformance suite checks something this crate would have to
add, **the fix goes into `gateway-core`** — two adapters that each carry half a
rule are two adapters that will disagree about it, on a phone somebody is
restoring. `tests/no_rules_here.rs` is the scan that keeps that from being a
sentence in a README.

| File | What it holds |
| --- | --- |
| `src/clock.rs` | the one reach for the wall clock; rules take time as an input |
| `src/sql.rs` | every statement, by `include_str!` from `contracts/gateway/` |
| `src/state.rs` | `StateStore` over SQLite; the compare-and-set under `BEGIN IMMEDIATE` |
| `src/bytes/` | `ByteStore` over a directory or a bucket, the mirror, and SigV4 |
| `src/tenancy.rs` | invites and quotas — **admission**, the one thing the deployments differ on |
| `src/http.rs` | axum over the rules, and the proxy a phone `PUT`s to |
| `src/serve.rs` | the listener, and the only one in this workspace |
| `src/acme.rs` | a certificate, with no second daemon |
| `src/service.rs` | the systemd unit and launchd agent an install writes |
| `src/config.rs` | what an operator wrote down, and the defaults if they wrote nothing |

## The gateway is blind

No plaintext, no plaintext hash, no key — ever, anywhere, including logs. The
state file's columns are `contracts/gateway/schema.sql`'s and the object store
holds ciphertext filed under the BLAKE3 of itself. `tests/canary.rs` plants a
plaintext, puts a derived ciphertext through the whole path, and then reads the
SQLite file's **raw bytes**, its rendered rows and every stored object looking
for either the plaintext or its hash.

The one thing this crate does not hash with BLAKE3 is in `src/bytes/sigv4.rs`,
and it is somebody else's protocol: AWS Signature Version 4 is an HMAC-SHA256
chain over a SHA-256 payload digest, and a signature restated in BLAKE3 would
not open a bucket. That file is the only one under this crate that names it, and
`crates/vault/tests/one_hash.rs` carries the allowlist entry that says why.

## Tests

```sh
cargo test -p centraid-gateway-server
```

- `tests/conformance.rs` — `gateway-core`'s own suite, **four times**:
  filesystem and S3 × attest and read-and-hash.
- `tests/tenancy.rs` — one tenant cannot read, head or delete another's objects.
- `tests/canary.rs` — the blindness scan, against a live store.
- `tests/first_run.rs` — it starts with no vault and no keys.
- `tests/no_rules_here.rs` — no rule was reimplemented in this adapter.
- `tests/container.rs` — the image and the CLI still agree about what to run.

## The container

[`deploy/gateway-server/`](../../deploy/gateway-server/README.md) holds the
Dockerfile and what to run it with — a tunnel, a Funnel or a reverse proxy,
ACME, a bucket, and what each default means.
