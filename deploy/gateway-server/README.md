# Running a Centraid gateway on a box at home

One image, one volume, one setting you have to get right. This is the
self-hosted half of "one protocol, two deployments" (#1029 §3): the phone
cannot tell whether it is talking to this or to the paid hosted offering, and
both pass the same conformance suite.

> **Not `deploy/docker/`.** That image runs `centraid`, which served an iroh
> QUIC endpoint to paired seats. This one runs `centraid-gateway`, which is an
> HTTP server a phone dials over a name.

## The shortest path

```sh
docker build -f deploy/gateway-server/Dockerfile -t centraid-gateway .

docker run -d --name centraid-gateway \
  -v centraid-vault:/var/lib/centraid \
  -p 8443:8443 \
  -e CENTRAID_GATEWAY_ORIGIN=https://vault.example.org \
  centraid-gateway
```

Then mint an invite and read it out to whoever is setting up their phone:

```sh
docker exec centraid-gateway centraid-gateway invite \
  --data-dir /var/lib/centraid --quota-gib 64
```

**Until somebody redeems an invite the server holds nothing.** There is no
vault, no account and no key in it, which is not a limitation to work around —
it is the point.

On a machine without Docker, the same thing without a container:

```sh
centraid-gateway serve --data-dir ~/vault --origin https://vault.example.org
centraid-gateway install --data-dir ~/vault --origin https://vault.example.org --dry-run
```

`install` writes a **user** systemd unit or a launchd agent, so it needs no
root; `--dry-run` prints the unit and its path and touches nothing.

## `CENTRAID_GATEWAY_ORIGIN` is the setting that has to be right

It is the name a phone dials, and **proxied upload targets are built from it**.
Get it wrong and the phone will authenticate fine, declare fine, and then hang
on a `PUT` to a name that does not resolve — a failure that looks like a network
problem for a long time before it looks like a config problem.

It must be the public name, not the container's, not `localhost`, and it must
carry the scheme.

## Getting it reachable without opening a port on your router

Three shapes, none of which needs an inbound port forward, and all three
terminate TLS in front — which is why `terminated` is the default and you do not
have to think about certificates at all.

### Cloudflare Tunnel

```sh
cloudflared tunnel --url http://localhost:8443
```

Set `CENTRAID_GATEWAY_ORIGIN` to the name the tunnel serves. Once it is up, bind
the container to `127.0.0.1:8443` rather than `0.0.0.0`: nothing else needs to
reach it.

### Tailscale Funnel

```sh
tailscale funnel 8443
```

Funnel prints the name it serves on (`https://<host>.<tailnet>.ts.net`); that is
the origin. Funnel holds the certificate and there is nothing to renew.

### A reverse proxy you already run

Caddy, two lines:

```
vault.example.org {
  reverse_proxy localhost:8443
}
```

An object is at most 16 MiB (F6), so no proxy needs a body limit beyond that —
but **nginx's default `client_max_body_size` of 1 MiB will break uploads**, and
the symptom is a 413 the phone reports as a failed transfer. Set it to `16m`.

### Or let the gateway get its own certificate

If the box really is reachable on 443 from the internet, write a config file:

```json
{
  "data_dir": "/var/lib/centraid",
  "bind": "0.0.0.0:443",
  "origin": "https://vault.example.org",
  "tls": {
    "kind": "acme",
    "domains": ["vault.example.org"],
    "contact_email": "you@example.org",
    "staging": true
  }
}
```

```sh
docker run -d -v centraid-vault:/var/lib/centraid -p 443:443 \
  centraid-gateway serve --config /var/lib/centraid/gateway.json
```

The challenge is **TLS-ALPN-01**, answered on the 443 the server is already
listening on: no port 80, and no DNS API token — the two things a home box
behind a tunnel usually cannot offer. **Leave `staging: true` for the first
run**: Let's Encrypt's production rate limit is per domain per week and a wrong
`origin` burns it quietly. Flip it to `false` once you have watched a
certificate be issued.

## Where the bytes go

By default: a directory under the volume. A home box has one disk, and that is
the honest default.

To use a bucket instead — MinIO, Backblaze B2, Wasabi, Garage, or R2 through its
S3 endpoint — put it in the config:

```json
{
  "store": {
    "kind": "s3",
    "endpoint": "http://minio.lan:9000",
    "bucket": "vault",
    "access_key_id": "…",
    "secret_access_key": "…",
    "checksum_mode": "attest",
    "presign": false
  },
  "mirror": {
    "kind": "filesystem",
    "path": "mirror",
    "checksum_mode": "read-and-hash"
  }
}
```

Two things worth knowing first:

- **`presign` is off, and leave it off unless the bucket is public.** With it
  off the gateway proxies the bytes; with it on the phone is handed a presigned
  URL straight to the bucket. That is faster and cheaper — and useless if the
  bucket is on your LAN, because the phone is not.
- **`checksum_mode` is a property of your store, not of this server.** B2 and
  MinIO differ on which checksum headers they attest, and R2 records one only
  when the client sent it. If commits start failing with
  `GATEWAY_CHECKSUM_MISSING`, your store is not attesting: switch to
  `read-and-hash`, which costs a read per commit and catches strictly more —
  including bytes that do not hash to the name they are filed under.

The optional `mirror` is a second store written on every upload, and it is what
lets `scrub --repair` do anything at all:

```sh
centraid-gateway scrub --data-dir /var/lib/centraid --repair
```

The scrub re-hashes every stored object **with no key** — an object's name is
the hash of its own ciphertext, so there is nothing to decrypt — and reports
what no longer hashes to its name. The repair copies the mirror's copy back,
and only if that copy hashes correctly.

## Append-only is off by default, and here is what turning it on means

```json
{ "append_only": true }
```

With it on, **devices cannot delete anything at all**: every delete a phone
sends is refused, and pruning becomes the owner's job. It is a real answer to a
real fear — a stolen phone cannot erase the family's photographs — and it is off
by default because a household that never heard of it must not discover it as a
backup that only grows until the disk fills.

It is not the only defence, and the others are on by default and need no
decision from you:

| Default | What it does |
| --- | --- |
| One client-directed base tombstone per vault per day | a stolen phone cannot outrun a rate limit |
| A retention floor over bases | one a day for a week, one a week for a month, one a month for six |
| A seven-day grace period | a tombstoned object keeps its bytes, so an undelete works |
| The size guard | while the backup has shrunk sharply, old bases cannot be pruned until somebody confirms on the phone |
| Server-side receipt times | retention is judged by this server's clock, so a phone cannot backdate real bases out of it |

## Backing up the box that holds the backups

Stop the container, copy `/var/lib/centraid` whole, start it again. **That is
everything.** There is no key to export, no keychain entry to keep in step and
no credential to adopt, because the gateway is blind: what it holds is public
keys, hashes of ciphertext, padded sizes and timestamps — and the ciphertext,
which nobody there can open.

The same property is why this image runs as an unprivileged user with the volume
as its only writable path, and why `centraid-gateway install` writes a unit with
`ProtectSystem=strict` and a single `ReadWritePaths`. A gateway is reachable
from the internet and is the process an attacker reaches first; it is worth
taking away everything it does not need, and it does not need much.

## Upgrading

```sh
docker stop centraid-gateway && docker rm centraid-gateway
# build or pull the new image, then the same `docker run` again
```

The schema is applied with `CREATE TABLE IF NOT EXISTS` on every start, so an
upgrade is a restart. A **downgrade is not supported**: a phone restoring from a
gateway that has forgotten a column is the failure this product exists to
prevent.
