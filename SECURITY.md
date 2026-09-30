# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in Centraid, please report it privately rather than filing a public issue.

- Email: **srikanth@crowdshakti.com**
- Subject line: `[centraid security] <short description>`

Please include:

- The affected component (a crate under `crates/`, the shell under `mobile/`, `packages/design`, or the build setup).
- Steps to reproduce, including OS and runtime versions.
- The impact you anticipate (e.g., local code execution, exfiltration of stored data, privilege escalation).
- Any suggested mitigations.

You should expect an initial acknowledgement within five business days. Please give a reasonable disclosure window before going public — at minimum until a fix has shipped or a workaround is documented.

## Supported versions

Centraid is pre-1.0 and ships from `main`. Only the latest commit on `main` is supported for security fixes. Older tags are not patched.

## Scope

In scope: code in this repository (`crates/`, `mobile/`, `packages/`, `deploy/`, `contracts/`, CI workflows under `.github/workflows/`).

Out of scope: third-party dependencies (report upstream), generic phishing or social-engineering reports against the maintainer's accounts, denial-of-service against personal infrastructure.

## Threat model — the phone is the vault (2026-09-21)

**Rewritten for v0** under [#1029](https://github.com/srikanth235/centraid/issues/1029) and the [scope amendment of 2026-09-21](https://github.com/srikanth235/centraid/issues/1029#issuecomment-5755559795). Everything this section said before described a gateway that held the vault, a seat plane, a desktop shell, a browser extension and a hosted tier. None of them exists. The rulings are in [decisions.md](docs/decisions.md#the-phone-is-the-vault--v0-1029-ruled-2026-09-21); the protocol is [docs/gateway.md](docs/gateway.md).

**The shape.** The phone holds `vault.db` and is its only writer. The member's laptop runs `centraid-gateway` and holds sealed objects it cannot open. The 24 words are the root of every key. The product keeps the words themselves only on a phone they were minted on or typed into, in its device-only secure store so settings can show them again ([R-1047-E10](docs/decisions.md#the-24-words-on-the-phone-1047-e1)); they never reach the laptop, the synchronised keychain or any backup.

### Trust anchors

| Anchor | What it is | Compromise means |
| --- | --- | --- |
| **The 24 words** | BIP39, 256 bits, no passphrase. Every vault key derives from it through a SLIP-0010 hardened tree. Minted in the core from the OS CSPRNG and shown at setup, and again from settings only after the phone's owner check; the seed is stored in the synced keychain by default, on this phone only where the platform will not sync it ([R-1047-E6](docs/decisions.md#the-24-words-on-the-phone-1047-e1)); the words are kept in this phone's device-only store ([R-1047-E10](docs/decisions.md#the-24-words-on-the-phone-1047-e1)) and written down by the member as the fallback | **Every vault the member has ever had, past and future.** This is the whole of the custody chain, and it is stated plainly at setup |
| **The phone itself, unlocked** | The vault file is plaintext SQLite behind the OS Data Protection class `CompleteUntilFirstUserAuthentication` | Everything the member's vault holds. The OS lock screen is the boundary |
| **The Locker member key `K`** | Derived from the 24 words at `seed / vault'(i) / locker'` ([D-6](docs/decisions.md#the-owners-rulings-of-2026-09-28-1047)), by the core at open with the vault's other keys, and held only in process memory — never written to disk; the vault stores only its generation id. It enters the Locker session only after the phone's biometric or passcode prompt succeeds (D-5), and a relock zeroes the session's copy; the copy a reveal, code or seal works with is zeroed when it drops (`LiveKey`, #1047 L6). It crosses no wire, and a restore from the 24 words re-derives it | Locker secret cells |
| **The device key** | Per phone, random, kept by the shell in the platform secure store marked **this-device-only and never synced**, certified by the vault identity key at an epoch ([W15-D3](docs/decisions.md#w15--the-phones-request-contract-1029)) | The ability to write to that vault's backup until a higher epoch supersedes it |
| **The laptop's `node.key`** | The iroh secret key under the gateway's data directory, mode 0600 | The ability to impersonate the laptop to paired phones — which gains an attacker **ciphertext** and the ability to lie about history, never plaintext |

There is **no multi-tenant server, no Centraid-operated cloud, and no account.** A laptop serves the vaults it holds; restore asks it.

### What the phone accepts: nothing

**The phone dials; it accepts no inbound connection.** It opens no listening socket and its iroh endpoint offers no ALPN and never calls `accept`. This is a structural rule rather than a convention: `cargo xtask rules`' `no-listening-socket` scans the whole workspace and catches a `TcpListener`, an endpoint that offers an ALPN, and an endpoint that accepts. The one exemption is `crates/gateway-server/src/serve.rs`, the laptop's listener, and the rule still scans every other file in that crate.

That is a security property and also the shape of v0: with no client but the phone there is no accept loop to get wrong. It is the deferral recorded as [R-1029-1](docs/decisions.md#the-phone-is-the-vault--v0-1029-ruled-2026-09-21), not an accident of scope.

### What a malicious laptop can do

A gateway is **trusted for availability and nothing else.**

- **It cannot forge.** Every object is named by the BLAKE3 of its bytes and the gateway re-hashes what it stores; a manifest is sealed and hash-chained to its predecessor. A gateway that altered a byte produces an object that opens as garbage or does not open, and a chain with a visible gap.
- **It cannot read.** Objects are sealed under per-object keys derived from the vault's root key, with kind and role bound into the AAD. The gateway holds no key and there is no path by which it could acquire one.
- **It can roll back** (F7). "Newest" is whatever its index says, and a **fresh** phone restoring from 24 words has no memory of the last head, so it cannot tell a truncated history from a short one. The partial mitigation is the manifest head in the vault's pkarr record, which a live record lets a restoring phone compare against — and which does not cover an expired record. **This is a stated limitation, not a solved problem.**
- **It can refuse, delay or lose.** A phone whose laptop is gone keeps writing; it is its own vault. What it loses is the backup, and the phone's screen says how long it has been since the last acked commit.
- **It can count.** Object sizes are **Padmé-padded**, which bounds the compression size-class leak below and does not remove it. Timing, generation churn and total volume are visible.

### What n0's relay and DNS server see

- **The DNS server** (`iroh-dns-server`, n0's by default and configurable to your own) holds each vault identity key's signed pkarr record: the laptop's endpoint id, the current device certificate and the manifest head. It learns **who resolves whom**, by IP, whenever a cached hint fails. It never sees vault bytes.
- **A relay** carries a hole-punch fallback over outbound TCP 443. It sees connection metadata — two endpoint ids, timing, byte counts — and never plaintext, because the stream inside it is QUIC-encrypted end to end.
- Neither is a trust anchor: a hostile DNS server can make a phone fail to find its laptop, which is a denial of service, and cannot make it find the wrong one, because the record is signed by the vault's identity key.

### The iOS backup asymmetry

**The plaintext vault must never enter the OS backup, and the seed deliberately does** (F5, [R-1029-8](docs/decisions.md#the-phone-is-the-vault--v0-1029-ruled-2026-09-21)).

Without Advanced Data Protection, an iCloud device backup is readable by Apple. That would mean Apple holding the member's plaintext vault while their own laptop holds only ciphertext, which is the exact inversion this design exists to prevent. So every path the app derives under the vault directory — the database, its `-wal` and `-shm`, the spool, the blob store, the thumbnail cache, `backup/laptop.json` — is marked `isExcludedFromBackup`. **Exclusion does not inherit**: a file created inside an excluded directory is not itself excluded, so each path is named and the sweep runs at three moments, including the one before iOS takes a backup. Android excludes by three mechanisms at once (`allowBackup="false"` plus both rule files).

The 64-byte **seed** is the opposite case and is in the synced keychain on purpose: iCloud Keychain is end-to-end encrypted, and a seed that does not survive a lost phone is a product with no recovery. The **device key** is never synced, because a device key in a synced keychain would make two phones one device — the exact condition the lease exists to prevent.

**Not proven here.** Nothing in CI compiles that Swift. What the inventory proves is that every derived path is named, that the exclusion call reaches the directory and every item under it, and that the sweep runs at the right moments. That iOS accepted the resource value is a physical-device check ([TESTING.md](TESTING.md)).

### A lost phone

1. **The member has the 24 words.** A fresh install takes them, derives the vault keys, resolves or scans the laptop, and restores from the newest manifest. The new phone is a **new device at epoch + 1**: the certificate is fresh, the lease moves, and the old phone — if it ever comes back online — is answered `VAULT_MOVED` and freezes read-only with its unacked commits visible rather than hidden (F1).
2. **The member does not have the 24 words and the seed was synced.** The keychain restores it, and the restore runs from that seed with no words typed (`RestoreRequest.seed`, [R-1047-E9](docs/decisions.md#the-24-words-on-the-phone-1047-e1)). This is the common path and the reason the seed is synced.
3. **Neither.** The vault is gone. There is no key escrow, no recovery service and no reset link, and this is said plainly at setup.

**The lease cannot enforce one writer** (F1), and the design says so: both phones can hold the seed, so "one device per vault" is a policy the phones cooperate with. What makes it safe is the freeze, the deliberate takeover and the manifest compare-and-set, which makes a race first-writer-wins with the loser told.

### The member key `K`

`K` is the seed's own leaf, `seed / vault'(i) / locker'` ([D-6](docs/decisions.md#the-owners-rulings-of-2026-09-28-1047)): the core derives it at open into its in-memory keyring, writes it nowhere, and the vault stores only its generation id (`locker_key`). A restore from the 24 words re-derives it, so sealed secrets reopen on the restored phone; a core opened without the seed has no `K` and refuses an unlock. A Locker write arriving at the command plane with plaintext is a receipted refusal (`assert_sealed_cell`), so the core seals what the member typed before the vault sees it, and the **reveal door is deleted from the access plane rather than refused**: `Verb` is `read` and `act`, and the access plane has no reveal judgement at all ([R-1047-D2](docs/decisions.md#the-sealedv1-cell-layer-and-the-retired-locker-generation-deleted-1047)). The unlock boundary is `crates/core/src/locker/phone.rs` ([D-5](docs/decisions.md#the-owners-rulings-of-2026-09-25-1047), [R-1047-L1…L4](docs/decisions.md#locker-on-the-phone-1047-d-5)): the shell raises the phone's own biometric prompt with the device passcode as fallback and reports the result; only then does the core put `K` in the session, receipt the unlock and open a session that idle ends after five minutes and that the shell relocks when Centraid leaves the foreground. A reveal writes its receipt before the value exists and lives thirty seconds.

**What that does not cover.** The biometric is an **in-app presence gate, not a cryptographic binding** ([D-7](docs/decisions.md#the-owners-rulings-of-2026-09-28-1047)). `K` derives from the seed, the seed reaches the core from the shell's synchronised secure store at open, and no OS keystore key that demands user authentication stands in front of either — so a keystore binding of `K` would be meaningful only once the seed itself is keystore-guarded, and it is not. The core holds `K` in process memory for as long as it is open (in its keyring, and in the Locker session while unlocked) — a host with root on an unlocked phone can read it, and anyone holding the 24 words can derive it. A revealed value crosses the ABI as a string the shells cannot zero; it is dropped from every state on conceal, on leave and on relock.

### Compression before encryption, and Padmé

A `base` range and a page `segment` are zstd'd against a trained dictionary and only then sealed, so a sealed object's length is a function of how **compressible** its plaintext was and not only of how long it was. Anyone who can see that length — the gateway, or an observer counting bytes — learns something a fixed-size envelope would not tell them. This is the CRIME/BREACH shape, and it is a deliberate trade: without the dictionary a one-row edit's 4 KiB page segment does not compress at all, and a backup nobody can afford to take is not a security property either.

**Padmé** (`crates/media/src/object/pad.rs`) pads every object's plaintext to a bucket whose width grows with its size, capping overhead at about 12% while collapsing many distinguishable lengths into few classes. **It bounds the leak; it does not remove it.** Two objects in different buckets are still distinguishable, and an adversary who can get plaintext of their choosing sealed still learns about what was compressed alongside it.

The dictionary itself rides inside the generation manifest, sealed ([R-1029-6](docs/decisions.md#the-phone-is-the-vault--v0-1029-ruled-2026-09-21)), so the gateway is as blind to it as to everything else.

### The backup is local

**A laptop-only backup is a local backup. Fire or theft takes phone and laptop together.** v0 accepts this and the member-facing copy must not overstate it. An off-site copy is a later proposal ([Q-1029-6](docs/decisions.md#open-questions-for-the-owner-1029)).

### What is deliberately absent

- **No sharing plane.** Share feeds, share capabilities, the link ceremony, the mailbox and every `share_*` table were deleted rather than parked, so there is no delivery surface to attack.
- **No account, no subscription, no hosted tier.** Nothing to bill, nothing to enumerate, no Centraid-side record that a member exists.
- **No desktop shell, no browser extension, no web client** in v0 ([R-1029-1](docs/decisions.md#the-phone-is-the-vault--v0-1029-ruled-2026-09-21)).
- **No assistant plane and no harness egress.** `crates/assist` and `crates/automations` are deleted; there is no provider a vault's bytes could reach.
- **No Centraid Assist OAuth courier.** The Worker, its Cloudflare deployment and the ceremony are deleted with the hosted tier. The documents that described it are marked superseded rather than removed: [docs/oauth-assist.md](docs/oauth-assist.md), [docs/release/oauth-assist-google.md](docs/release/oauth-assist-google.md), [docs/recovery/oauth-assist.md](docs/recovery/oauth-assist.md).

### Explicitly not yet implemented / incomplete

Treat the following as **open**, not as shipping guarantees:

- Rollback detection by a **fresh** phone when the pkarr record has expired (F7).
- An OS keystore in the path of `K` on an unlocked device — meaningful only once the seed itself is keystore-guarded ([D-7](docs/decisions.md#the-owners-rulings-of-2026-09-28-1047)).
- An off-site copy of the backup.
- Formal third-party audit of the object format, the signing scheme and the transport.

### Related

- [docs/gateway.md](docs/gateway.md) — the protocol and the laptop
- [docs/recovery/pairing.md](docs/recovery/pairing.md) · [docs/recovery/backup-restore.md](docs/recovery/backup-restore.md)
- [docs/logs.md](docs/logs.md)

## The claim register

Every security claim this document makes, what enforces it, and — where nothing does — who owns the gap. A row is **ENFORCED-BY-TEST** only when the named test fails if the property stops holding; anything weaker says so in its own words. Adding a claim to this document without adding its row is the thing this table is here to stop.

| Claim | Status | Enforced by |
| --- | --- | --- |
| The phone owns no listening socket, offers no ALPN and never accepts | ENFORCED-BY-RULE | `no-listening-socket` in `cargo xtask rules`, over every crate and every file of `crates/gateway-server` but `serve.rs` |
| The laptop's gateway cannot produce Locker plaintext: `K` is the seed's leaf, derived in the core and never written to disk ([D-6](docs/decisions.md#the-owners-rulings-of-2026-09-28-1047)), and everything the vault serves or backs up carries a Locker secret only as `lk1:` ciphertext under `K` — including a backup base range once its own `centraid-object/1` seal is opened | ENFORCED-BY-TEST | `nothing_the_vault_serves_or_backs_up_carries_locker_plaintext` and its falsification, `crates/vault/tests/locker_plaintext_gate.rs`; `the_vault_file_does_not_reveal_a_cell_without_k`, `crates/vault/src/custody/locker_key.rs`; `a_secret_is_sealed_only_while_the_session_is_open` (no `keys` directory is ever created), `crates/core/src/app_query/locker_tests.rs` |
| A plaintext secret is refused at every door that takes one | ENFORCED-BY-TEST | `a_plaintext_secret_is_refused_at_every_door_that_takes_one`, `crates/vault/tests/locker_commands.rs` |
| The audit band is append-only in the engine | IMPLEMENTED IN SCHEMA | the `RAISE(ABORT, …)` triggers in `contracts/schema/vault-ddl.sql` |
| An object's name is the BLAKE3 of its bytes, and the gateway checks it | ENFORCED-BY-TEST | `crates/gateway-core`'s conformance suite, run against the server adapter |
| The manifest head moves only under a compare-and-set | ENFORCED-BY-TEST | the conformance suite's race case; `crates/gateway-core/src/commit.rs` |
| A device certificate cannot be relabelled with another key and still verify | ENFORCED-BY-TEST | `crates/identity/src/certificate.rs` — the key is inside the signed bytes, with a test for exactly that |
| The lease refuses an epoch at or below the one it holds | ENFORCED-BY-TEST | `crates/gateway-core/src/lease.rs`; `DeviceTrust` in `crates/identity` |
| A restore moves the lease only for a generation that opened and passed `integrity_check` and its census; a refused one leaves the old phone writing and no file on the new phone (#1047 R3, L7) | ENFORCED-BY-TEST | `crates/core/src/phone/restore.rs` (`GET …/head` first, claim last); `crates/centraid/tests/drain_wire.rs::a_refused_restore_leaves_the_lease_where_it_was` |
| A multi-vault restore claims no lease until every vault has checked, and a claim that fails after another landed answers the claimed vault rather than dropping it (#1047 M1) | ENFORCED-BY-TEST | `crates/centraid/tests/drain_wire.rs::a_restore_that_refuses_one_vault_claims_none`, `::a_claim_that_fails_after_another_landed_answers_the_claimed_vault` |
| A restore's claim names the head it checked, so a head that moves before the claim moves no lease until the new head has checked (#1047 L1) | ENFORCED-BY-TEST | `crates/gateway-core/src/conformance.rs` `lease/a-restore-claim-at-a-moved-head-is-refused-and-moves-nothing`; `crates/centraid/tests/drain_wire.rs::a_head_that_moves_to_a_damaged_generation_before_the_claim_moves_no_lease`, `::a_head_that_moves_to_a_good_generation_before_the_claim_is_the_one_restored` |
| HPKE, BIP39 and SLIP-0010 match their published vectors | ENFORCED-BY-TEST | `crates/identity/tests/rfc9180.rs` (RFC 9180 A.1), and the vectors in `crates/identity/src/{phrase,derive}.rs` |
| A vault derivation index is never reused | ENFORCED-BY-TEST | `DeriveError::VaultIndexReused`, `crates/identity/src/derive.rs` |
| Object sizes are bounded, not exact | **DOCUMENTED NON-CLAIM** | Padmé bounds the compression leak; see above. Nothing makes a sealed object's size secret |
| A gateway cannot roll a fresh phone's history back | **NOT ENFORCED — open** | the pkarr head is a partial mitigation and does not cover an expired record (F7) |
| A host with root cannot read `K` off an **unlocked** device | **NOT ENFORCED — open** | no OS keystore is in that path; `K` is the seed's leaf and the seed is not keystore-guarded ([D-7](docs/decisions.md#the-owners-rulings-of-2026-09-28-1047)) |
| The Locker biometric is a presence gate, not a cryptographic binding of `K` | **DOCUMENTED NON-CLAIM** | [D-7](docs/decisions.md#the-owners-rulings-of-2026-09-28-1047); nothing in the core opens a cell without a reported unlock, and nothing binds `K` to the prompt |
| A restore from the 24 words reopens sealed Locker secrets, and no `K` is written to disk — no file under the vault's directory holds `K`'s raw bytes or hex after an unlock, a seal, a reveal and a relock (#1047 L5) | ENFORCED-BY-TEST | `a_restore_from_the_same_words_reopens_sealed_secrets`, `a_secret_is_sealed_only_while_the_session_is_open`, `crates/core/src/app_query/locker_tests.rs`; `the_locker_key_is_the_seeds_and_no_other_seeds`, `crates/identity/src/derive.rs`; `lockerKeyHex` in `contracts/crypto/identity-vectors.json` |
| The shells hand the seed to the core only at open, read it from the secure store for that one open, and keep it in no field or state; a vault with no recorded index opens unkeyed rather than at a guessed index | ENFORCED-BY-TEST | `KeyedOpenSpec` (`mobile/shared/src/jvmTest`) over `Shelf`'s every open; `CoreConfiguration.toString` redacts the seed and the device secret |
| The 24 words are minted from the OS CSPRNG in the core, and neither the words nor the seed reach a log line, a receipt or an error detail | ENFORCED-BY-TEST | `a_minted_phrase_is_24_list_words_that_check_valid_and_seed`, `a_refused_seed_quotes_no_word`, `crates/core/src/phone/phrase.rs`; `the_words_are_minted_judged_and_seeded_over_a_core_with_no_vault`, `crates/core-ffi/tests/contract.rs`; the redacted `toString`s in `VaultWordsSpec` and `WordsEntrySpec` (`mobile/shared`) |
| A vault is founded only after its words were shown and three were typed back, and its seed is stored before the found | ENFORCED-BY-TEST | `VaultWordsSpec` (the machine and the flow's order), `EnrollmentSpec` ([R-1047-E1](docs/decisions.md#the-24-words-on-the-phone-1047-e1)) |
| A seed that arrived by sync never founds a vault at an index another phone spent | ENFORCED-BY-TEST | `seedSettled` in `VaultSecretsSpec`; `PHASE_RESTORE_FIRST` in `VaultWordsSpec` ([R-1047-E2](docs/decisions.md#the-24-words-on-the-phone-1047-e1)) |
| Restoring or re-keying with different words over vaults this phone keys is refused before anything is stored or dialled | ENFORCED-BY-TEST | `EnrollmentSpec` ([R-1047-E3/E5](docs/decisions.md#the-24-words-on-the-phone-1047-e1)) |
| The device secret a keyed open carries is the one the core minted at pair or restore; the shell mints none, and an unkeyed open carries none | ENFORCED-BY-TEST | `VaultSecretsSpec`, `WordsShelfSpec` ([R-1047-E4](docs/decisions.md#the-24-words-on-the-phone-1047-e1)) |
| A restore takes the 24 words or the 64-byte seed, exactly one, and no refusal quotes a word or a byte of either | ENFORCED-BY-TEST | `a_restore_takes_the_words_or_the_seed_and_never_both` (`crates/core/src/phone/mod.rs`); `EnrollmentSpec` for the held-seed restore ([R-1047-E9](docs/decisions.md#the-24-words-on-the-phone-1047-e1)) |
| The words are kept only in this phone's device-only store, never the synchronised one, after the seed they derive is stored, and are forgotten with it | ENFORCED-BY-TEST | `EnrollmentSpec` ([R-1047-E10](docs/decisions.md#the-24-words-on-the-phone-1047-e1)) |
| Settings reads the words only after the phone's owner check passed, and drops them on leaving | ENFORCED-BY-TEST for the machine; **the check itself is the views'** | `WordsShowSpec` (no read before `Verified`, nothing held after Done or dismissal). The check is native: iOS `LAContext .deviceOwnerAuthentication`, walked on the simulator (a no-match reads VerifyFailed, a match shows the words, and leaving the foreground drops them); Android `BiometricPrompt` with `BIOMETRIC_STRONG or DEVICE_CREDENTIAL`, built and not walked |
| The words at rest resist a host with root on an unlocked device | **NOT ENFORCED — open** | the device-only store is the platform keystore's, as for the device key; the words are one more secret in the same place as the seed ([D-7](docs/decisions.md#the-owners-rulings-of-2026-09-28-1047)) |
| A found killed between the core's commit and the shell's record neither loses the vault's index nor spends it twice | ENFORCED-BY-TEST | `KeyedOpenSpec` (the crash window: pending index recorded at the next launch, given back when no file was made or the found was refused) ([R-1047-E11](docs/decisions.md#the-24-words-on-the-phone-1047-e1)) |
| Words typed to re-key are checked against the vault they re-key | **DOCUMENTED NON-CLAIM** | they are checked against their BIP39 checksum and any seed already on the phone, not against the vault — the vault holds no fingerprint of its identity key; another person's valid words open a Locker whose reveals answer `DID_NOT_OPEN` ([R-1047-E5](docs/decisions.md#the-24-words-on-the-phone-1047-e1)) |
| The words screens are shielded from capture, the clipboard and keyboard learning | IMPLEMENTED on both shells; **no automated test**, and **the iOS capture shield is unverified** | The machines set `secure` on the screens that show words (`VaultWordsSpec`, `WordsShowSpec`), and the views honour it. **Android** (`screens/words/`): `FLAG_SECURE` on the activity window **and** on the sheet's own dialog window. Seen on the emulator for words.make: `dumpsys window` lists both as SECURE, and `screencap` is black. words.show takes the same path and was not walked. The word fields drop the text toolbar and the clipboard, and carry `IME_FLAG_NO_PERSONALIZED_LEARNING`, `NO_SUGGESTIONS` and `VISIBLE_PASSWORD`; the EditorInfo was read back on the emulator. A long press on a shown word offers no copy. **iOS** (`WordsViews.swift`): the content is drawn inside a secure text field's canvas, and covered while `UIScreen.isCaptured` or the scene is not active. The word fields have no edit menu, no paste, no drag or drop, and no autocorrection, spelling, prediction or content type. It was built and drawn on the simulator, but `simctl io screenshot` reads the framebuffer, so the shield and the switcher cover are **unverified until a device screenshot and recording** ([v1-handoffs](docs/release/v1-handoffs.md) 1.7). Residual: Gboard's clipboard chip commits text through the input method, and no field can refuse it |
| An open Locker is shielded from capture | IMPLEMENTED on both shells; the gate's half ENFORCED-BY-TEST; **the shells' half has no automated test and is unverified on hardware** | `LockerLockState.secure` is set exactly while UNLOCKED and cleared by every relock (`the capture shield holds exactly while the Locker is open, and a relock drops it`, `LockerSpec`), so the views decide nothing of when ([D-10](docs/decisions.md#the-owners-rulings-of-2026-09-29-1047)). **Android** (`screens/locker/LockerRoutes.kt`): `FLAG_SECURE` on the activity window while a Locker route is composed and `secure` holds, as a counted hold shared with the words sheets (`SecureWindow`), and dropped on relock or on leaving Locker; Locker's sheets and dialogs are made after it and inherit it. **iOS** (`Locker/`, `Kit/TrashListView.swift`): the words screens' `WordsShield` (secure canvas; covered while captured or not active) over every open page's content — home, item, editor and the trash list (the kit's `TrashListView(secure:)`) — and over the item's memo and confirm sheets and the trash's confirm, each of which states its `SheetPresentation` again outside the canvas; an item page draws no title in the navigation bar while `secure`, its shielded header carries it. Outside the canvas stay only the app's own words — a bar's title (`Locker`, `Trash`, `Edit item`) and back label — and the home page's More and Facts sheets, which name no item. On the simulator an XCTest screenshot (Maestro's `takeScreenshot`) leaves every shielded surface blank while the framebuffer (`simctl io screenshot`) draws it; the OS screenshot, recording and switcher on a device are [v1-handoffs](docs/release/v1-handoffs.md) 1.7 |
| A test proves a release build accepts no seed from its launch environment | **DOCUMENTED NON-CLAIM** | nothing builds a release shell to check it; by review, the demo's dev seed is read only under `#if DEBUG` (`ShellModel.devSeedHex`) and behind `FLAG_DEBUGGABLE` (`MainActivity`); neither shell carries the demo words or seed in source ([mobile/README.md](mobile/README.md#the-demo-vault-opens-keyed)) |
| A locked Locker seals nothing, and a reveal is receipted before its value exists | ENFORCED-BY-TEST | `a_secret_is_sealed_only_while_the_session_is_open`, `a_reveal_is_receipted_opens_the_cell_and_is_refused_once_relocked`, `crates/core/src/app_query/locker_tests.rs` |
| A one-time-code seed never leaves the core: the phone asks for codes, and a reveal naming `otp_seed` is refused `SEED_NOT_SHOWN` before the session is consulted and before any receipt | ENFORCED-BY-TEST | `a_one_time_code_is_receipted_first_and_is_rfc_6238s_code_for_now`, `crates/core/src/app_query/locker_tests.rs` ([R-1047-D6](docs/decisions.md#the-owners-rulings-on-the-locker-leftovers-1047)) |
| A custom sealed field is sealed by the core against its own id before the vault sees it, while Locker is open, and reveals only through the item's door: a live item's sealed field, receipt first, naming the field's id and whether the value was shown or copied, never its label or value ([R-1047-T2-1](docs/decisions.md#lockers-follow-ups-on-the-phone-1047-t2)) | ENFORCED-BY-TEST | `a_custom_sealed_field_is_sealed_here_and_reveals_through_the_items_door`, `crates/core/src/app_query/locker_tests.rs`; `a_field_reveal_receipt_names_the_field_and_what_the_value_was_for`, `the_sealed_field_door_answers_a_live_items_sealed_field_only`, `crates/vault/tests/locker_commands.rs`; `a sealed custom field reveals and copies through the core…`, `a relock drops a field typed into the sheet`, `LockerTransferSpec` |
| A passkey's key is never revealed, copied, exported or imported on the phone: a reveal naming `private_key` is refused `KEY_NOT_SHOWN` before the session is consulted and before any receipt, and a rename keeps the key and its generation ([R-1047-T2-2](docs/decisions.md#lockers-follow-ups-on-the-phone-1047-t2)) | ENFORCED-BY-TEST | `a_passkeys_metadata_reads_and_its_key_is_never_revealed`, `an_export_is_receipted_first_and_carries_every_secret_but_a_passkeys_key`, `crates/core/src/app_query/locker_tests.rs`; `a_passkey_renamed_with_the_placeholder_keeps_its_key_and_generation`, `crates/vault/tests/locker_commands.rs`; `neither_format_carries_a_passkeys_key`, `crates/apps/locker/src/transfer.rs` |
| An item's access history carries no value — only the act, the column or field id, and the time ([R-1047-T2-3](docs/decisions.md#lockers-follow-ups-on-the-phone-1047-t2)) | ENFORCED-BY-TEST | `an_items_access_history_is_its_receipts_as_metadata`, `crates/core/src/app_query/locker_tests.rs` |
| An export is refused while Locker is locked, is receipted as one mass reveal before any secret is opened, and carries neither the trash nor a passkey's key ([R-1047-T2-4](docs/decisions.md#lockers-follow-ups-on-the-phone-1047-t2)) | ENFORCED-BY-TEST | `an_export_is_receipted_first_and_carries_every_secret_but_a_passkeys_key`, `crates/core/src/app_query/locker_tests.rs` |
| An export asks the confirm, then the phone's owner check afresh, before the core is asked; the file is held off every drawn state and dropped on any answer, relock or leave, and goes only to the OS save sheet — never a temporary file, a cache or app storage | the machine half ENFORCED-BY-TEST; **the shells' half IMPLEMENTED, with no automated test** | `export asks the confirm, then the owner check afresh, and only then the core`, `the file goes to the save sheet and nowhere else…`, `LockerTransferSpec`; iOS `LockerTransferRoot` (`.fileExporter` over an in-memory document), Android `LockerRoutes.ExportRoute` (`CreateDocument`, written through the chosen URI). Walked on the iOS simulator (#1047 T2): the file landed only in the Files provider's storage. The owner check is D-7's presence gate — the core cannot see it |
| An import writes nothing until Add, seals every secret on the way in, and never replaces a value the vault holds; a picked file is read in place and never written to app storage or a drawn state ([R-1047-T2-5](docs/decisions.md#lockers-follow-ups-on-the-phone-1047-t2)) | the core and machine halves ENFORCED-BY-TEST; the pickers IMPLEMENTED | `an_import_plans_then_seals_in_and_the_vault_wins`, `a_json_export_imports_back_whole`, `crates/core/src/app_query/locker_tests.rs`; `the_plan_gives_the_handoffs_verdicts_and_the_vault_wins`, `an_entry_prints_no_secret`, `crates/apps/locker/src/transfer.rs`; `import reads a picked file through the core…`, `LockerTransferSpec` |
| A plaintext export is a file the member chose to make; what reads it afterwards reads every secret in it | **DOCUMENTED NON-CLAIM** | the handoff's lede says so on the page, verbatim; there is no encrypted export ([R-1047-T2-4](docs/decisions.md#lockers-follow-ups-on-the-phone-1047-t2)) |
| No Locker app-query answer carries a secret or its ciphertext | ENFORCED-BY-TEST | `no_answer_carries_a_secret_or_its_ciphertext` (same file); `no_phone_statement_projects_a_sealed_cell_except_as_its_presence`, `crates/apps/locker` |
| A locked Locker reads nothing, and a relock wipes what a screen held | ENFORCED-BY-TEST | `LockerSpec`, `mobile/shared` — the machine half; the shell's prompt and `Backgrounded` are the view wave's |
| Every vault-derived path on iOS is excluded from the OS backup | IMPLEMENTED, **measured only on a physical device** | the eight-row inventory and its sweep; nothing in CI compiles that Swift |
| A forgotten person's face regions are deleted, and nobody else's | ENFORCED-BY-TEST | `crates/vault/tests/media_commands.rs` |
| A panic inside the core poisons the handle instead of crossing the ABI | ENFORCED-BY-TEST | `a_real_panic_inside_call_poisons_the_handle_through_the_abi`, `crates/core-ffi`, run by the `fault-door` gate step |
| A restore from 24 words reproduces the vault end to end | ENFORCED-BY-TEST | the `restore-drill` step of the `release` profile |

## Automated security gates

Complementary controls on top of manual review and the threat model above. The PR gate is `cargo xtask gate --profile pr` in `.github/workflows/gate.yml` (`crates/xtask/src/gate.rs`).

| Gate | Where | What it catches | What it does not replace |
| --- | --- | --- | --- |
| **GitHub secret scanning + push protection** | Repo setting (enabled) | Known provider token patterns on push/PR | Non-provider high-entropy strings |
| **Gitleaks** | gate step `secrets` (`gitleaks detect --no-git --config .gitleaks.toml`) | High-entropy / generic secrets in the current tree; fixtures allowlisted in [`.gitleaks.toml`](.gitleaks.toml) | Full git-history archaeology |
| **dependency-review** | `gate.yml` job `dependency-review` (PR only) | _New_ high-severity advisories and banned copyleft licenses introduced by the PR | Latent vulnerabilities already in the lockfiles |
| **OSV-Scanner** | gate step `osv` → [`scripts/ci/osv-lockfile-scan.mjs`](scripts/ci/osv-lockfile-scan.mjs) | Full `bun.lock` inventory; **fails on CRITICAL** only; HIGH is logged | Typosquat/malware behavioral signals |
| **cargo-deny** | gate step `deny` (`cargo deny --all-features --config deny.toml check`) | Rust advisories, licences, banned and duplicate crates | The JS lockfile, which OSV and dependency-review own |
| **Advisory register** | gate step `advisory` | An accepted advisory past its expiry | Deciding whether an advisory should be accepted |
| **CI policy** | gate step `ci-policy` (`lint:workflow-pins`, `lint:ci-egress`, `lint:path-filters`) | Unpinned actions, and a workflow that installs dependency code without `harden-runner` beyond the shrink-only [`egress-ledger.json`](scripts/security/egress-ledger.json) | Enforcement inside the ledgered workflows |
| **CodeQL** `security-extended` | [`candidate.yml`](.github/workflows/candidate.yml) job `codeql`, on every push to `main` | SAST for TS/JS, Actions YAML, Rust | Per-PR wall-clock budget |
| **Rust supply chain** | [`candidate.yml`](.github/workflows/candidate.yml) job `rust-supply-chain`, on every push to `main` | `cargo-audit` and `cargo-deny` findings, plus [`scripts/security/unsafe-edge-audit.mjs`](scripts/security/unsafe-edge-audit.mjs): a new `unsafe` block, or one without a `// SAFETY:` justification | Whether an existing justification is _correct_ |
| **Trivy** | [`lane-release-gateway-image.yml`](.github/workflows/lane-release-gateway-image.yml) after image push | CRITICAL/HIGH OS and package CVEs in the gateway image; exceptions in [`.trivyignore`](.trivyignore) with reason + review date | Scanning every app surface |

**Roles (lockfile):** dependency-review = “don’t _add_ a known-bad dep on this PR.” OSV = “what is _already_ in the lockfile?” so inventory debt cannot hide behind an unrelated change.

**Re-apply / local:**

```bash
cargo xtask gate --profile pr
# or one tool at a time:
gitleaks detect --source . --no-git --config .gitleaks.toml
node scripts/ci/osv-lockfile-scan.mjs   # with osv-scanner on PATH
```

SonarCloud Autoscan remains a second-opinion maintainability/security check on PRs; it is not one of these gates, and it is **token-gated**: analysis is SonarCloud-side Automatic Analysis on the `srikanth235_centraid` project, and the project's configuration — scope exclusions, silenced noise rules, quality profiles and gate — is applied by `scripts/ci/configure-sonarcloud.mjs`, run from [`.github/workflows/sonarcloud.yml`](.github/workflows/sonarcloud.yml) on pushes that touch the configurator, weekly, and on manual dispatch. That lane runs only when the optional `SONAR_TOKEN` secret is present (a personal token with project administer); without it every step is skipped and the run logs an explicit skip notice, so a clone or fork with no token gets no SonarCloud coverage rather than a silent half-configured one. Policy detail lives in [the toolchain contract](docs/toolchain.md#sonarcloud-autoscan).
