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

**The shape.** The phone holds `vault.db` and is its only writer. The member's laptop runs `centraid-gateway` and holds sealed objects it cannot open. The 24 words are the root of every key, and there is no second copy of them anywhere in this product.

### Trust anchors

| Anchor | What it is | Compromise means |
| --- | --- | --- |
| **The 24 words** | BIP39, 256 bits, no passphrase. Every vault key derives from it through a SLIP-0010 hardened tree. Stored in the synced keychain by default and written down by the member as the fallback | **Every vault the member has ever had, past and future.** This is the whole of the custody chain, and it is stated plainly at setup |
| **The phone itself, unlocked** | The vault file is plaintext SQLite behind the OS Data Protection class `CompleteUntilFirstUserAuthentication` | Everything the member's vault holds. The OS lock screen is the boundary |
| **The vault DEK** | AES-256-GCM, seals sealed-column cells as `sealed:v1:` with a `<table>.<column>:<rowId>` AAD | Every sealed column except Locker secrets |
| **The Locker member key `K`** | Minted on the device that founds the vault, wrapped at rest under the member's Locker passphrase with Argon2id (m = 64 MiB, t = 3, p = 1) and AES-GCM. It crosses no wire | Locker secret cells |
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
2. **The member does not have the 24 words and the seed was synced.** The keychain restores it. This is the common path and the reason the seed is synced.
3. **Neither.** The vault is gone. There is no key escrow, no recovery service and no reset link, and this is said plainly at setup.

**The lease cannot enforce one writer** (F1), and the design says so: both phones can hold the seed, so "one device per vault" is a policy the phones cooperate with. What makes it safe is the freeze, the deliberate takeover and the manifest compare-and-set, which makes a race first-writer-wins with the loser told.

### The member key `K`

`K` is minted on the device that founds the vault and the vault stores only its id. A Locker write arriving with plaintext is a receipted refusal (`assert_sealed_cell`), and the **reveal door is deleted rather than refused**: `Verb` has no reveal arm and `SealedSubject::new` cannot be constructed for the `locker` schema at all. The unlock boundary is `crates/core/src/locker`: the passphrase minimum is 12 characters, there is no stored verifier — a wrong passphrase fails AEAD authentication — a session lasts five minutes of idle time and a reveal window thirty seconds.

**What that does not cover.** An unlocked session holds `K` in process memory, and no OS keystore is in that path. A host with root on an unlocked phone can read it.

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
- An OS keystore in the path of `K` on an unlocked device.
- A biometric or device-lock gate in the app, above the OS lock screen.
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
| A gateway cannot produce Locker plaintext | ENFORCED-BY-TEST | `crates/vault/tests/member_key_gate.rs` |
| A plaintext secret is refused at every door that takes one | ENFORCED-BY-TEST | `a_plaintext_secret_is_refused_at_every_door_that_takes_one`, `crates/vault/tests/locker_commands.rs` |
| The audit band is append-only in the engine | IMPLEMENTED IN SCHEMA | the `RAISE(ABORT, …)` triggers in `contracts/schema/vault-ddl.sql` |
| An object's name is the BLAKE3 of its bytes, and the gateway checks it | ENFORCED-BY-TEST | `crates/gateway-core`'s conformance suite, run against the server adapter |
| The manifest head moves only under a compare-and-set | ENFORCED-BY-TEST | the conformance suite's race case; `crates/gateway-core/src/commit.rs` |
| A device certificate cannot be relabelled with another key and still verify | ENFORCED-BY-TEST | `crates/identity/src/certificate.rs` — the key is inside the signed bytes, with a test for exactly that |
| The lease refuses an epoch at or below the one it holds | ENFORCED-BY-TEST | `crates/gateway-core/src/lease.rs`; `DeviceTrust` in `crates/identity` |
| HPKE, BIP39 and SLIP-0010 match their published vectors | ENFORCED-BY-TEST | `crates/identity/tests/rfc9180.rs` (RFC 9180 A.1), and the vectors in `crates/identity/src/{phrase,derive}.rs` |
| A vault derivation index is never reused | ENFORCED-BY-TEST | `DeriveError::VaultIndexReused`, `crates/identity/src/derive.rs` |
| Object sizes are bounded, not exact | **DOCUMENTED NON-CLAIM** | Padmé bounds the compression leak; see above. Nothing makes a sealed object's size secret |
| A gateway cannot roll a fresh phone's history back | **NOT ENFORCED — open** | the pkarr head is a partial mitigation and does not cover an expired record (F7) |
| A host with root cannot read `K` off an **unlocked** device | **NOT ENFORCED — open** | no OS keystore is in that path |
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
