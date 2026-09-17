# Receipt — the phone is the vault ([#1029](https://github.com/srikanth235/centraid/issues/1029))

One receipt for the umbrella. Each wave appends a section; the state this
produces lives in [docs/decisions.md](../docs/decisions.md) and the docs the
umbrella's doc pass touches, and where the two disagree the doc is what is
current.

## W0.5 — identity (lane A): keys, certificates, HPKE, safety numbers

`crates/identity` is new, and it is the whole of the product's identity model:
one 24-word phrase, a SLIP-0010 hardened tree under it, and the four things
built on the leaves — device certificates, HPKE to a box key, and the safety
number two people read to each other.

### What landed

| Where | What |
| --- | --- |
| `crates/identity/Cargo.toml` (new) | `centraid-identity`, lib `centraid_identity`. Deps: `bip39`, `ed25519-dalek`, `x25519-dalek`, `hpke`, `hmac`, `sha2`, `blake3`, `rand`, `hex`, `subtle`, `base64`, `thiserror`. |
| `crates/identity/src/lib.rs` (new) | `#![forbid(unsafe_code)]`, the module map, and the standing rule that the SHA-2 in this crate is spent on published specifications and nothing else. |
| `crates/identity/src/phrase.rs` (new) | `RecoveryPhrase` — generate from `rand::rngs::OsRng`, parse, the settings re-check, and `Seed`. No BIP39 passphrase, deliberately: a second secret with no recovery path. Both secrets have a redacting `Debug`. |
| `crates/identity/src/derive.rs` (new) | SLIP-0010 hardened derivation. `AccountKey::derive` is `seed / account'`; `VaultMint::mint` is `seed / vault'(i) / {identity', box', root'}`. `VaultMint` carries the account's high-water mark and refuses an index at or below it (F2). `restore_vault_keys` re-derives a known index without moving a mark. |
| `crates/identity/src/certificate.rs` (new) | `DeviceKey` (random, per phone), `DeviceCertificate` ("K certifies D at epoch E", signed by K over all three), `Epoch` (monotonic `u64`, saturating), `DeviceTrust` (holds the highest epoch accepted and refuses an equal or lower one). |
| `crates/identity/src/sealed_box.rs` (new) | HPKE base mode, DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / AES-128-GCM. `AssociatedData { kind, role }` is length-prefixed and bound into the AEAD. |
| `crates/identity/src/safety_number.rs` (new) | 60 digits in 12 groups of 5, BLAKE3 over the two identity keys **sorted by their bytes**, so both people read the same number. |
| `crates/identity/tests/identity_vectors.rs` (new) | Generates and diffs `contracts/crypto/identity-vectors.json`; `CENTRAID_UPDATE_FIXTURES=1` regenerates and the comparison still runs. |
| `crates/identity/tests/rfc9180.rs` (new) | Replays RFC 9180 Appendix A.1 — the RFC's recipient key, encapsulated key, ciphertexts and exported values. |
| `contracts/crypto/identity-vectors.json` (new) | The account key, three vaults' identity/box/root values, and the rendered safety number, from BIP39's zero-entropy phrase. |
| `contracts/crypto/rfc9180-vectors.json` (new) | RFC 9180 Appendix A.1's base-mode vector, transcribed from the CFRG file `hpke 0.14.1` ships. Nothing in this repository produced these bytes. |
| `Cargo.toml` | Workspace entries for `bip39`, `ed25519-dalek`, `x25519-dalek`, `hpke` and `hmac`, each with the reason its feature set is pared to what one ciphersuite needs; the `sha2` comment widened to name `crates/identity` as `xtask`'s co-tenant of the carve-out. |
| `Cargo.lock` | The resolved graph for the above. |

### Where the vectors come from, and why it matters

Three of the four things this lane pins have a published answer, and this lane
uses it rather than its own output:

- **BIP39** — the zero-entropy English phrase, and its empty-passphrase seed,
  checked against a PBKDF2 implementation outside this workspace before the
  constant was written (`phrase.rs`).
- **SLIP-0010** — ed25519 test vector 1, master node and three hardened
  children, asserted against `Node` directly (`derive.rs`).
- **RFC 9180** — Appendix A.1's ciphertexts, opened with A.1's recipient key
  (`tests/rfc9180.rs`).

`contracts/crypto/identity-vectors.json` is the one fixture this repository
generates, because the paths and the safety-number rendering are ours. Per
Reference A, **D-1020-R1 is dropped pre-release**: nothing has shipped, so these
are regression vectors, freely regenerated until first release. The test's
module header says so and names what has to be deleted to end it.

### Rulings spent

- **W0.5-R1 — standards-mandated hashes are somebody else's protocol.** SHA-512
  (BIP39's PBKDF2, SLIP-0010's HMAC) and SHA-256 (RFC 9180's HKDF) enter the
  workspace, restricted to `crates/identity`, as the same carve-out `xtask`
  already holds for Subresource Integrity and the Actions cache key
  (D-1025-S4-5). `blake3` remains ONE HASH for everything this repository
  defines itself — the safety number is BLAKE3 for exactly that reason. **This
  is a root ruling put to the owner with a recommendation, not a settled
  decision**; the `docs/decisions.md` supersession of D-1025-S4-5 is W9's. If
  the owner refuses it, `phrase.rs`, `derive.rs` and `sealed_box.rs` change
  shape, and the crate leaves the BIP39/SLIP-0010/RFC 9180 standards behind
  with them.
- **W0.5-R2 — the pair ticket is W2's move.** `crates/net/src/ticket.rs` is
  untouched here.
- **F2 — a vault index is never reused.** A typed refusal
  (`DeriveError::VaultIndexReused`), not a comment.
- **F3 — epochs are monotonic; backup generations are random.** Nothing in this
  crate orders anything by a generation.
- **D-1020-R1 dropped pre-release** — see above.

### Decisions this lane made that are not in a ruling

Recorded here because `registry-completeness` says a decision this lane makes
goes in the receipt; the `docs/decisions.md` entries are W9's.

1. **The account key takes `0x7fff_ffff`, the top of the hardened space, and
   vault indices are the plain counting numbers.** The alternative — an offset,
   so vault 0 is `m/1'` — puts arithmetic between the number in the account
   record and the number in the path, and that arithmetic is exactly what F2
   says must never be got wrong. `VaultMint` refuses the reserved index by
   name.
2. **The box key is the leaf at `box'`, a sibling of `identity'` under the same
   vault node.** Reference B forbids converting the Ed25519 key; this is the
   shape that satisfies it with one tree and one master tag.
3. **No BIP39 passphrase.** `RecoveryPhrase::seed` takes no argument. A
   passphrase is a second secret with no recovery path, and a person who
   forgets it cannot tell that from a mistyped word. Adding one later is a new
   method, never a changed default.
4. **`AssociatedData` is length-prefixed.** `kind = "ab", role = "c"` and
   `kind = "a", role = "bc"` must not be one string.
5. **`SealError::Open` is one variant for decapsulation and for the AEAD tag.**
   Telling a caller which half of their guess to keep is an oracle.
6. **A device certificate carries the identity key inside the signed bytes**, so
   relabelling a genuine certificate with a victim's key does not make it
   verify. There is a test for exactly that.

### Found, not fixed — not this lane's slice

- **`cargo fmt --all --check` fails on 18 files that predate this branch**:
  `crates/centraid/src/{allowlist.rs,main.rs,run.rs,tails.rs}`,
  `crates/centraid/src/cmd/native_host/methods.rs`,
  `crates/centraid/tests/{byte_lane.rs,bytes_upward.rs,derive_sweep.rs,seat_bootstrap.rs,seat_identity.rs,seat_lane.rs}`,
  `crates/core/src/handle.rs`, `crates/media/src/renditions.rs`,
  `crates/seat-link/src/{link.rs,seat.rs}`, `crates/seat/src/{bytes.rs,sync.rs}`,
  `crates/vault/tests/derivatives.rs`. `cargo fmt --all` was run once, its
  edits to those files were reverted, and none of them are in this lane's
  commits — another lane owns them and a formatting sweep from here would
  collide.
- **`cargo clippy --workspace --all-targets -- -D warnings` fails on
  `crates/vault/src/log/guard.rs:47`** — `field 'capture' is never read` on
  `CommitTx`. Pre-existing, and `crates/vault` is not this lane's.
- **`hpke`'s deterministic-encapsulation seam is `pub(crate)`**, so the RFC 9180
  replay covers the receiver half only. What that leaves unproven is the
  ephemeral keypair generation, which is `getrandom` and not a format decision;
  decapsulation, the key schedule and the AEAD are shared by both directions.
- **Lane B's surface exists but has no consumer yet.**
  `DeviceCertificate::{to_bytes,from_bytes}` is the fixed-width form the pkarr
  record's `cert=` entry carries, and `SealedBox::{to_bytes,from_bytes}` is
  `enc ‖ ct`. Both are tested here and neither is called outside this crate.
