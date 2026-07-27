# Recovery: founding and enrollment

Use this runbook when a gateway has no vault, a pairing capability expired, or
a device lost its private iroh identity. Ground truth for relay e2e remains
`tests/agent-e2e-pairing/AGENTS.md`.

## Zero-vault founding

1. Start `centraid-gateway serve` on the host. A healthy zero-vault gateway
   reports `status: "uninitialized"` and keeps serving.
2. From the host, run `centraid-gateway init-ticket --data-dir … --qr`. The
   daemon must be running; the 10-minute capability is host-possession-gated,
   one-time, and has no `vaultId`.
3. Scan or paste it on the first phone/desktop. Choose Create or Restore.
4. Create requires a recovery-kit password, delivery of the wrapped kit,
   re-selecting and opening that file, and explicit loss consent. Home remains
   unavailable until verification succeeds. The proved first EndpointId becomes
   the vault's `owner`.
5. Restore requires the wrapped kit, its password, and provider credentials.
   Provider credentials are never stored in the kit. The recovered keyring and
   vault DEK enter custody through `KeyStore`.

For headless automation that deliberately accepts no recovery kit, use
`serve --init-vault <name>`. This is not the human first-run ceremony.

## Ordinary enrollment

Once a vault exists:

1. An enrolled owner mints `centraid-gateway pair --data-dir … --vault …`
   (`--qr` for a terminal QR).
2. The device redeems the one-time capability over the iroh pairing ALPN.
3. Redemption and the `gateway.db` enrollment commit atomically. New ordinary
   devices receive `full` trust unless a narrower trust was requested.
4. Subsequent requests are admitted by the enrolled EndpointId. There is no
   direct-HTTP pairing route or per-device bearer.

## Durable state

| Location | Role |
| --- | --- |
| `gateway.db` | Exclusive process lock; enrollments, one-time tickets, web sessions, preferences, backup/storage control state |
| `keys/endpoint-key.bin` | Wrapped gateway iroh identity; losing it changes EndpointId and requires every device to re-pair |
| Device secure storage | Per-connection private iroh key |
| Desktop `connections.json` | Non-secret, device-local gateway registry keyed by EndpointId |

Headless `keys/` files are encrypted with either OS/service custody or an
external `0600` host credential under the platform configuration directory.
That fallback credential is deliberately outside the gateway data dir, so a
data-dir copy contains no parseable raw key material.

Relay hints/tickets are refreshable address cache. They are not durable gateway
identity and changing one must not create a second connection record.

## Recovery steps

### Capability expired or was consumed

Mint a new capability. Never try to revive or edit the old value. Minting a new
founding capability invalidates the previous one.

### Device enrolled but cannot connect

1. Run `centraid-gateway lock-status --data-dir …`; distinguish a free lock
   from a held-but-unresponsive daemon.
2. Confirm the target vault still exists and the EndpointId remains enrolled
   with `centraid-gateway devices list`.
3. If the device secure store was cleared, revoke the old EndpointId and pair a
   newly minted identity.
4. For relay-only failures, run
   `tests/agent-e2e-pairing/flows/cross-network-relay.mjs` and inspect the kept
   test workspace.

### Sole owner is lost

Use the filesystem-anchored device CLI on the gateway host. Revoking the last
owner requires typed confirmation because it leaves only this SSH/console
recovery path.

### Gateway identity is corrupt or lost

Stop the daemon before custody work. A corrupt non-32-byte endpoint key refuses
with recovery instructions. Restore the original `keys/endpoint-key.bin`; deleting
it deliberately mints a new identity and requires every device to re-pair.

## Do not

- Hand-edit `gateway.db` while the daemon holds its exclusive lock.
- Persist pairing tickets as gateway identity.
- Copy device credentials into the gateway data directory.
- Commit real tickets, endpoint secrets, or recovery kits.
