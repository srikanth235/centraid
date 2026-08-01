# device-pairing-lifecycle

The full pairing ceremony (issue #289) with every real component in its real process: daemon, admin CLI, and a device played by `@centraid/tunnel`.

## Goal

Prove the current pairing workflow end to end: mint a pasteable ticket on the gateway host, redeem it from a device that has never been seen before, and end up with an enrollment that gates the tunnel — surviving a daemon restart and dying on revocation. There is no SSH transport in this flow.

## Setup

Fresh `--data-dir`, no bootstrap flag: the daemon auto-founds `Shared` + `Personal` at construction (issue #603 removed `--init-vault`). The harness waits for the HTTP listener and the iroh endpoint identity.

## Steps

1. `pair --vault "Shared"` — parse the pasteable base64url token; assert it carries the gateway EndpointTicket, ticket id/secret, vault name, expiry.
2. Fresh device identity redeems over `centraid/gw-pair/1` → `ok: true` with the vault id/name + version-handshake material.
3. The paired-device roster shows the durable `gateway.db` row and platform.
4. A tunneled `GET /centraid/_vault/vaults` from the enrolled device → 200.
5. Replaying the same ticket → refused (burned on success).
6. Restart the daemon on the same data dir: EndpointId is unchanged (identity is protected host custody, not per-boot) and the SAME device tunnels again without re-pairing (enrollment persisted).
7. The device revokes its own enrollment → its next tunnel attempt is refused at the QUIC layer.

## Verdict

PASS iff every step above holds; any refusal that should be an admission (or vice versa) throws.
