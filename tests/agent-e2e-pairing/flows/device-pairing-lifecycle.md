# device-pairing-lifecycle

The full pairing ceremony (issue #289) with every real component in its real
process: daemon, admin CLI, and a device played by `@centraid/tunnel`.

## Goal

Prove the SSH-bootstrap workflow an owner actually performs works end to end:
mint a pasteable ticket on the gateway box, redeem it from a device that has
never been seen before, and end up with an enrollment that gates the tunnel —
surviving a daemon restart, and dying on revocation.

## Setup

Fresh `--data-dir` (the daemon bootstraps its default vault); harness waits
for the HTTP listener and the iroh endpoint identity.

## Steps

1. `vault create --name Family` — a second, named vault to pair into.
2. `pair --vault Family` — parse the pasteable base64url token; assert it
   carries the gateway EndpointTicket, ticket id/secret, vault name, expiry.
3. Fresh device identity redeems over `centraid/gw-pair/1` → `ok: true` with
   the Family vault id/name + version-handshake material.
4. `devices list --vault Family` shows the device's EndpointId; the same row
   is in `devices.json` on disk, with the platform the device reported.
5. A tunneled `GET /centraid/_vault/vaults` from the enrolled device → 200.
6. Replaying the same ticket → refused (burned on success).
7. Restart the daemon on the same data dir: EndpointId is unchanged
   (identity is `endpoint-key.bin`, not per-boot) and the SAME device tunnels
   again without re-pairing (enrollment persisted).
8. `devices revoke <endpointId>` → the device's next tunnel attempt is
   refused at the QUIC layer.

## Verdict

PASS iff every step above holds; any refusal that should be an admission (or
vice versa) throws.
