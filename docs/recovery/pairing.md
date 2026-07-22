# Recovery: pairing / enrollment

When device pairing strands mid-ceremony. Ground truth for e2e: `tests/agent-e2e-pairing/AGENTS.md`.

## Ceremony sketch

1. Gateway running with iroh endpoint bound (`endpoint.json` published).
2. Admin mints a one-time ticket (`pair` CLI / UI).
3. Device redeems ticket (secret + endpoint); enrollment written to `devices.json`.
4. Ticket burned; device uses durable enrollment / device token thereafter.

### Headless VPS — form-factor map

| Client | Mint | Redeem |
| --- | --- | --- |
| **Desktop / PWA** | `centraid-gateway pair --data-dir … [--vault …]` | Paste one-line ticket into **Add gateway** |
| **Phone** | Same command with **`--qr`** (UTF-8 terminal QR of the same token) | Scan QR **or** paste ticket under mobile **Settings → Gateway link** |

`pair --json` is for automation (no QR on stdout). Desktop "Connect phone" QR remains a separate `centraid-pair` shape for phone↔desktop hub; VPS tickets are always `centraid-gw-pair`.

## Files (daemon `dataDir` or gateway dir)

| File | Role |
| --- | --- |
| `endpoint.json` | Live endpoint id + dial ticket |
| `endpoint-key.bin` | Gateway iroh secret (0600) — **do not delete** casually |
| `pairing-tickets.json` | One-time tickets (hashes + TTL) |
| `devices.json` | Enrollments |
| `device-tokens.json` | HTTP bearer hashes |
| `web-sessions.json` | PWA control sessions |

## Symptoms

- QR / ticket paste fails with invalid or expired
- Redeem succeeds once, second try fails (burned — expected)
- Device cannot dial after gateway restart
- "Works on loopback e2e, fails for real phone" (relay path)

## Steps — ticket expired or burned

1. **Mint a new ticket.** Do not try to revive burned secrets.
2. Wrong secret burns the ticket — correct secret is useless afterward (hygiene invariant).
3. Ensure clock skew is not huge (TTL).

## Steps — gateway has no endpoint yet

1. `pair` before `endpoint.json` exists always fails.
2. Wait for serve readiness (`endpoint:` log line) or restart gateway and watch [logs.md](../logs.md).
3. Airgapped machines may be slow/fail binding production relay config — expected limitation for full relay tests.

## Steps — device enrolled but cannot talk

1. Confirm gateway process is up (H1 policy: should stay up when desktop window closed — until detached lands, keep desktop/daemon running).
2. Confirm vault id the device targets still exists.
3. Check enrollment still in `devices.json`; revoke + re-pair if device key was wiped on the phone.
4. After J4, secrets should live in secure storage — if the app was reinstalled, re-pair.

## Steps — revoke and start clean

1. Use `devices` CLI / UI revoke for the device id.
2. Clear client pairing state (app storage / secure store).
3. Mint fresh ticket; redeem once.

## Steps — corrupted enrollment files

1. **Stop** the gateway.
2. Back up `devices.json` / `pairing-tickets.json` before editing.
3. Prefer CLI revoke/list over hand-JSON surgery.
4. If `endpoint-key.bin` is lost, the gateway identity changes — **all devices must re-pair** (new endpoint id).

## Steps — cross-network / relay only failures

1. Loopback pairing e2e does **not** prove relay.
2. Run `tests/agent-e2e-pairing/flows/cross-network-relay.mjs` (Docker) when touching tunnel dial code.
3. On FAIL, inspect kept workspace under `runs/<runId>/`.

## What not to do

- Reuse a failed device identity for a later happy-path assertion in tests
- Hand-merge two `devices.json` copies from different machines
- Commit real tickets or endpoint secrets

## Related

- `packages/gateway/src/serve/pairing-store.ts`, `enrollment-store.ts`
- `packages/tunnel`
- [SECURITY.md](../../SECURITY.md) — trust model
