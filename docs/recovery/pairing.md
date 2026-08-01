# Recovery: auto-founding and enrollment

Use this runbook when a gateway's first boot did not produce the vaults you expect, a pairing capability expired, or a device lost its private iroh identity. Ground truth for relay e2e remains `tests/agent-e2e-pairing/AGENTS.md`.

## Auto-founding (issue #603)

There is no founding ceremony, no founding ticket, and no `uninitialized` state. A gateway founds itself:

1. Start `centraid-gateway serve` (or start the desktop-controlled local gateway) on a **fresh** data dir. At construction the gateway creates two vaults, in this order:
   - **Shared** — the household vault. Created first; explicit `--vault Shared` targets it.
   - **Personal** — the founder's private vault and registry default. On desktop it is renamed to the founder's display name once the profile step completes; a headless gateway that never sees a profile step keeps the name `Personal`.
2. The host's own device identity is enrolled as the owner **member**, `admin` on both vaults, in the same `gateway.db` transaction.
3. Nothing else happens. No kit is minted, no capability is issued, and no screen blocks the user.

A data dir that **already** holds vault directories is never modified. `VaultRegistry.isFresh()` counts a vault directory that failed to mount, so corruption or a missing custody key can never make an existing gateway look fresh and get founded over its own data.

If a gateway does look empty, that is a real fault, not a legal state — check `centraid-gateway status --data-dir …` and `vault list`, both of which report `failedMounts` distinctly from an empty registry.

Restoring an existing vault onto a blank machine is the **backup plane**, not founding: see [backup-restore.md](backup-restore.md) (`centraid-gateway recover --kit …`).

## Ordinary enrollment

Once a gateway is running:

1. On the gateway host, run `centraid-gateway pair --data-dir … [--vault …]` (`--qr` for a terminal QR). The command talks to the running loopback daemon on the configured port. With no member flag it pairs another device to the existing owner and carries all of that owner's current grants. Omitting `--vault` targets the registry default, which on an auto-founded gateway is the owner's **Personal** vault.
   - Use `--member <id-or-label>` to pair another device for an existing household member.
   - Creating a person is always explicit: `--new-member <label> [--grant <vault>:<role>]…`.
2. The device redeems the one-time capability over the iroh pairing ALPN.
3. Redemption and the `gateway.db` enrollment commit atomically. The redeeming device supplies its own display name; this is separate from the saved gateway label and can be renamed later from Household.
4. Subsequent requests are admitted by the enrolled EndpointId. There is no direct-HTTP pairing route or per-device bearer.

## Durable state

| Location | Role |
| --- | --- |
| `gateway.db` | Exclusive process lock; enrollments, one-time tickets, web sessions, preferences, backup/storage control state |
| `keys/endpoint-key.bin` | Wrapped gateway iroh identity; losing it changes EndpointId and requires every device to re-pair |
| Device secure storage | Per-connection private iroh key |
| Desktop `connections.json` | Non-secret, device-local gateway registry keyed by EndpointId |

Headless `keys/` files are encrypted with either OS/service custody or an external `0600` host credential under the platform configuration directory. That fallback credential is deliberately outside the gateway data dir, so a data-dir copy contains no parseable raw key material.

Relay hints/tickets are refreshable address cache. They are not durable gateway identity and changing one must not create a second connection record.

## Recovery steps

### Capability expired or was consumed

Mint a new pair ticket. Never try to revive or edit the old value. Tickets burn on first **successful** redeem only — a wrong secret is rejected before the ticket row is deleted, so the genuine ticket still redeems afterwards.

### `pair` reports a rejected credential

`pair` fails with a bearer-mismatch error naming `CENTRAID_GATEWAY_TOKEN` when the daemon was launched with a pinned bearer this CLI cannot derive from `keys/endpoint-key.bin`. Restart the daemon without the pin, or run the command with `CENTRAID_GATEWAY_TOKEN` set to the same value. This used to be reported as "the iroh endpoint is not ready" — a lie the owner could not act on (issue #603).

### Device enrolled but cannot connect

1. Run `centraid-gateway lock-status --data-dir …`; distinguish a free lock from a held-but-unresponsive daemon.
2. Confirm the target vault still exists and the EndpointId remains enrolled with `centraid-gateway devices list`.
3. If the device secure store was cleared, revoke the old EndpointId and pair a newly minted identity.
4. For relay-only failures, run `tests/agent-e2e-pairing/flows/cross-network-relay.mjs` and inspect the kept test workspace.

### Sole owner is lost

Use the filesystem-anchored device CLI on the gateway host. Revoking the last owner requires typed confirmation because it leaves only this shell/console recovery path — Centraid itself no longer offers any SSH-routed connect (issue #603 deleted that code).

### Gateway identity is corrupt or lost

Stop the daemon before custody work. A corrupt non-32-byte endpoint key refuses with recovery instructions. Restore the original `keys/endpoint-key.bin`; deleting it deliberately mints a new identity and requires every device to re-pair.

## Do not

- Hand-edit `gateway.db` while the daemon holds its exclusive lock.
- Persist pairing tickets as gateway identity.
- Copy device credentials into the gateway data directory.
- Commit real pair tickets, endpoint secrets, or recovery kits.
- Delete `vault/` to "reset" a gateway — that is how you get a data dir the auto-found bootstrap will happily found over.
