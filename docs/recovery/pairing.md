# Recovery: pairing a phone to a laptop

Use this runbook when pairing did not take, an invite expired, or a phone stopped being able to find
its laptop. The protocol is [../gateway.md](../gateway.md); the rulings are
[decisions.md](../decisions.md#the-phone-is-the-vault--v0-1029-ruled-2026-09-21).

**The vault is on the phone.** The laptop is a blind store. Losing the laptop loses the backup, not
the vault; losing the phone is [backup-restore.md](backup-restore.md).

## Founding

A vault is founded **on the phone**, at first launch. It mints 24 words, derives the vault's keys
from them and creates `vault.db` in the directory the shell hands the core. Nothing on a laptop
founds anything: `centraid-gateway serve` on an empty directory creates a state file, listens, and
serves nothing to nobody until an invite is redeemed.

## Ordinary pairing

1. On the laptop: `centraid-gateway serve --data-dir <dir>` in one terminal, and
   `centraid-gateway invite --data-dir <dir> --quota-gib <n>` in another. The invite command prints
   the invite code, a `pair` payload, and that payload as a **half-block Unicode QR** a phone camera
   can read straight off the terminal. Both commands must point at the same `--data-dir`: the invite
   must be redeemable while `serve` is running, and two processes share it through the state file.
2. On the phone: the `Pair` flow scans the QR. The phone admits itself, claims the lease and writes
   the laptop's endpoint id to `backup/laptop.json` beside its vault.
3. **Compare the safety number.** 60 digits in 12 groups of 5, shown on both sides. It is BLAKE3 over
   the two identity keys sorted by their bytes, so both sides render the same digits without agreeing
   an order first. An empty safety number means the phone could not compute one and is drawn as that
   — never as "it matched". A hex endpoint id is **not** the thing to compare: it is a string people
   check the first four characters of and stop.
4. `centraid-gateway invites --data-dir <dir>` lists the invites and what became of each.

An invite is **one-use and expires**. A second phone needs a second invite.

## Durable state

| Location | Role |
| --- | --- |
| The phone's `vault.db` | **the vault.** Everything. Backed up as sealed objects and by nothing else |
| The phone's platform secure store | the 64-byte seed (synced by default — iCloud Keychain is end-to-end encrypted) and the **device key** (this-device-only, **never synced**) |
| The phone's `backup/laptop.json` | the paired laptop's `EndpointId`. Device-local derived state, deliberately not in the vault ([W15-D1](../decisions.md#w15--the-phones-request-contract-1029)) — lose it and the phone re-pairs |
| `<data-dir>/node.key` on the laptop | the laptop's long-term iroh identity. Losing it changes the endpoint id and **every paired phone must pair again** |
| `<data-dir>` state file on the laptop | the object index, the manifest heads, the leases, the invites and the quotas |

An invite's secret is held **only as its hash**. Relay and DNS hints are a refreshable address cache,
never identity.

## Recovery steps

### The invite expired or was already redeemed

Mint a new one: `centraid-gateway invite --data-dir <dir>`. Never try to revive or edit the old
value. A wrong code and an unknown invite are the same refusal.

### The phone cannot find the laptop

1. Confirm `centraid-gateway serve` is running and printed its `endpoint` line. Compare that id
   against what the phone holds.
2. `centraid-gateway health --url …` for the TCP carrier; under the iroh carrier the endpoint line
   `serve` prints on every start is the equivalent, and it is the same id on every start unless
   `node.key` moved.
3. If `serve` warned that it **minted a fresh node key**, the laptop's identity changed and every
   phone must pair again. That happens only if `node.key` was deleted or could not be read.
4. n0's DNS or relay being unreachable is a denial of service, not a compromise: the record is signed
   by the vault's identity key, so a hostile resolver can make a phone fail to find its laptop and
   cannot make it find the wrong one. Read [../logs.md](../logs.md).

### The phone says `VAULT_MOVED`

A device at a higher epoch has claimed the lease — normally a restore onto a new phone. This phone
freezes read-only with its unacked commits visible. That is the design (F1): the lease cannot
*enforce* one writer, because both phones can hold the seed, so it shows the conflict rather than
hiding it. Taking the vault back is a deliberate takeover from the phone you want to keep, not a
repair on the one that was superseded.

### The laptop's disk is gone

The vault is unaffected. Set up a new laptop, mint a fresh invite, pair again, and let the phone
drain from its spool. **What is lost is the history the old laptop held**, which is what
[Q-1029-6](../decisions.md#open-questions-for-the-owner-1029) — the off-site copy — is about.

### An object on the laptop is corrupt

`centraid-gateway scrub --data-dir <dir>` re-hashes every stored object and reports bit rot;
`--repair` restores what a mirror still holds intact. It needs no key.

## Do not

- Hand-edit the phone's `vault.db`, or copy it anywhere. See
  [../traps/wal-checkpoint.md](../traps/wal-checkpoint.md).
- Persist an invite payload anywhere, or commit one.
- Delete `node.key` to "reset" a laptop — every phone re-pairs.
- Treat the laptop's data directory as a second vault. It holds no key and nothing that opens one.
