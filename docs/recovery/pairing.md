# Recovery: pairing a phone to a gateway

Use this runbook when pairing did not take, a pairing QR expired, a phone stopped reaching its gateway, or a gateway moved. The protocol is [../gateway.md](../gateway.md); the rulings are [decisions.md](../decisions.md#backups-from-first-principles-1080).

**The vault is on the phone.** A gateway is a blind store. Losing a gateway loses that copy of the backup, not the vault; losing the phone is [backup-restore.md](backup-restore.md).

## Founding

A vault is founded **on the phone**, at first launch. It mints 24 words, derives the vault's keys from them and creates `vault.db` in the directory the shell hands the core. Nothing on a gateway founds anything: `centraid-gateway serve` on an empty directory mints the gateway's identity, listens, and stores nothing until a phone pairs.

## Ordinary pairing

1. On the gateway: `centraid-gateway serve --data-dir <dir>`. While nothing has paired, `serve` prints a pairing payload and its QR; beside a running `serve`, `centraid-gateway pair --data-dir <dir>` prints a fresh one. Both commands point at the same `--data-dir`. A payload is `{v: 2, gw, addrs, pin, secret, exp_ms}`: the gateway's id, the addresses to dial, the BLAKE3 of its certificate, and a secret that admits **one** vault, once, within 24 hours.
2. On the phone: **Pair with your laptop** on the band's More sheet, or **Add a gateway** on the Backup screen, takes the payload scanned or pasted ([R-1047-E12](../decisions.md#the-24-words-on-the-phone-1047-e1)). The phone dials the addresses in order, refuses any certificate whose BLAKE3 is not the pin, pairs with the secret, and records the gateway in its ledger.
3. **Compare the safety number.** 60 digits in 12 groups of 5: the phone's paired screen shows it, and `serve` prints it as a `safety` line the moment the pairing lands; `pairings` prints it again beside each vault. Both are `centraid_identity::pairing_safety_number` over the vault's identity key and the gateway certificate's pin, sorted by their bytes, so both sides show the same digits without agreeing an order first ([D-9](../decisions.md#the-owners-rulings-of-2026-09-29-1047)). Every group must match. An empty safety number means the phone could not compute one, and it refuses that pairing ("Centraid could not check who answered") rather than show a blank — never "it matched".
4. `centraid-gateway pairings --data-dir <dir>` lists each vault with its writer epoch, its head, its tokens and what each may do, and how many pairing secrets are waiting, spent or expired.

**More than one gateway** is the same steps with each gateway's own QR ([R-1080-8](../decisions.md#backups-from-first-principles-1080)). The phone backs up to whichever it can reach, the LAN one when home, and the Backup screen lists each with when it was last seen.

## Durable state

| Location | Role |
| --- | --- |
| The phone's `vault.db` | **The vault.** Everything. Backed up as snapshots and by nothing else. |
| The phone's platform secure store | The 64-byte seed — synced by default, because iCloud Keychain is end-to-end encrypted and a seed that does not survive a lost phone is a product with no recovery — and the 24 words in the device-only store. |
| The phone's `<stem>.backup.db` | The ledger: each paired gateway's addresses, certificate, token and epoch; the queue; every name each gateway confirmed; the snapshots this phone took; where each content hash's bytes are on this phone. Device-local and derived, never in the vault and excluded from OS backup — lose it and the phone pairs again and reconciles. |
| The phone's `<stem>.spool/` | Sealed parts waiting to move. Derived; lose it and the next pass seals again. |
| `<data-dir>/tls.key`, `tls.crt`, `gateway.id` on the gateway | **The gateway's identity.** Every paired phone pins the certificate. Lose them and the gateway mints a new identity that every paired phone refuses. Back them up with the data directory. |
| `<data-dir>/state.db` on the gateway | The vaults and their writer epochs, the hashes of tokens and pairing secrets, the heads and snapshot history, and the index of every object. It is what makes `objects/` findable: back it up with them. |
| `<data-dir>/objects/` on the gateway | The sealed objects. |

A pairing secret and a token are each held by the gateway **only as their hash**: neither can be printed again.

A data directory a gateway kept before [#1080](https://github.com/srikanth235/centraid/issues/1080) holds `node.key`, the iroh secret key that was the laptop's identity then. Nothing reads it now: a protocol v2 gateway is identified by its certificate, and a phone pairs with it afresh.

## Recovery steps

### The QR expired or was already used

Print a new one: `centraid-gateway pair --data-dir <dir>`. Never try to revive or edit the old payload. A spent, an expired and an unknown secret are the same `UNAUTHORIZED`.

### The phone cannot reach the gateway

1. Confirm `centraid-gateway serve` is running: it prints `listening <address>` on start. `centraid-gateway health --data-dir <dir>`, on the same machine, asks it over TLS with its own certificate.
2. Confirm the phone can dial it. **LAN first** ([R-1080-9](../decisions.md#backups-from-first-principles-1080)): on the same network the phone browses `_centraid-gateway._tcp` whenever the app is open and refreshes the gateway's addresses, so a laptop that moved to a new address is found again; away from that network only an address the phone can reach directly — a VPS, a VPN — works. Nothing relays.
3. Confirm the port is open: 8443 by default. A macOS firewall asks once whether `centraid-gateway` may accept incoming connections.
4. The phone counts what waits on an unreachable gateway as waiting, with the time it was last seen, and resumes from the same place when it answers. Nothing is lost by waiting. Read [../logs.md](../logs.md).

### The phone says `PIN_MISMATCH`

Something answered at the gateway's address with a different certificate, and the phone sent it nothing. Either another machine now has that address — find the gateway, and the phone picks up its new address on the LAN — or the gateway lost its identity files and minted new ones, which `serve` shows as a new `pin` line. In that case restore `tls.key`, `tls.crt` and `gateway.id` from the data directory's backup, or forget the gateway on the phone and pair it again with a fresh QR. There is no "trust the new certificate" button, by design.

### The phone says `MOVED`

A phone at a higher epoch has claimed the vault — normally a restore onto a new phone. This phone freezes read-only with everything it holds still visible. That is the design (F1): the gateway cannot _enforce_ one writer, because both phones can hold the seed, so it shows the conflict rather than hiding it. Taking the vault back is a deliberate takeover from the phone you want to keep, not a repair on the one that was superseded.

### A gateway's disk is gone

The vault is unaffected. Set up a gateway, pair the phone again, and its next passes upload a full snapshot and every original and derivative it still holds bytes for — from the operating system's library or from its own store. **What is lost** is the snapshot history that gateway held, and any original the phone had already evicted because that gateway acknowledged it — unless a second gateway holds a copy, which is what a second gateway is for.

### An object on a gateway is damaged

`centraid-gateway scrub --data-dir <dir>` re-hashes every stored object against the digest recorded when it arrived, now rather than at the quarterly sweep. A damaged object is marked and reads as missing, so a phone that still holds the bytes sends it again on its next pass. No key is involved.

### The gateway moves to another machine

Stop `serve`, copy the whole data directory, and start `serve` from the copy. The identity travels with it, so every paired phone still trusts it; on the LAN the phone finds the new address by browsing.

## Do not

- Hand-edit the phone's `vault.db`, or copy it anywhere. See [../traps/wal-checkpoint.md](../traps/wal-checkpoint.md).
- Persist a pairing payload anywhere, or commit one: its secret admits a vault for a day.
- Delete `tls.key`, `tls.crt` or `gateway.id` to "reset" a gateway — every paired phone refuses what it mints instead.
- Put a proxy that terminates TLS in front of a gateway. The phone pins the gateway's own certificate, so it refuses the proxy's.
- Treat a gateway's data directory as a second vault. It holds no key and nothing that opens one.
