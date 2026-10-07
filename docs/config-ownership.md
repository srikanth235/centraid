# Config ownership (F3)

When both a **declarative file** and a **runtime tool** (UI, IPC, CLI) can write the same surface, one side **wins**. The other is overwritten or ignored. This pre-empts "my settings vanished" support.

## Rule of thumb

| If you care about… | Prefer |
| --- | --- |
| Reproducible / git-reviewed config | Declarative file is source of truth; runtime is a view or temporary override that re-reads the file |
| End-user preference on a single machine | Runtime (UI) owns the file; hand-editing is unsupported while the process is running |

Never claim both are durable writers without a merge strategy — Centraid does not implement general CRDT config merge.

## Surfaces

### Gateway data directory — the running gateway wins

A gateway holds no vault: the vault is on the phone, and a gateway's data directory is its identity and a blind store of sealed objects ([#1080](https://github.com/srikanth235/centraid/issues/1080)). One layout, stated in [gateway.md](gateway.md#the-data-directory):

| Path | Owner | Notes |
| --- | --- | --- |
| `tls.key`, `tls.crt`, `gateway.id` | `centraid-gateway serve`, at its first start | The gateway's identity, minted together, mode 0600. Every paired phone pins the certificate, so a gateway that minted afresh is one they all refuse |
| `state.db` | `serve`; `pair`, `pairings` and `scrub` open it beside a running `serve` | Vaults and writer epochs, the hashes of tokens and pairing secrets, heads, the object index and tombstones. Hand-editing is unsupported |
| `objects/`, `incoming/` | `serve` | The sealed objects; uploads being staged, emptied at start |
| `serve.json`, `sweeps.json` | `serve` | The address it last bound, which `pair` and `health` read; when the purge and the scrub last finished |

Operator inputs are flags and environment, read at start: `--data-dir` (or `CENTRAID_GATEWAY_DATA_DIR`), and `serve`'s `--bind` (or `CENTRAID_GATEWAY_BIND`) and `--no-mdns`. There is no gateway config file and no prefs store.

### Vault ontology settings — vault commands win

| Surface | Owner | Notes |
| --- | --- | --- |
| `core_vault.settings_json` and related rows | Journalled vault commands | Direct SQL against `vault.db` bypasses consent and is unsupported |
| `enrich_policy` | Vault founding ([`crates/vault/src/bootstrap.rs`](../crates/vault/src/bootstrap.rs)) | Seeded `gateway` for `photos` and `docs`; no command in this build changes it, and Photos reads it without being able to set it |

### Mobile — the platform secure store wins

Two secrets per vault in the platform store, and their sync postures are deliberately opposite ([#1029](https://github.com/srikanth235/centraid/issues/1029)): the **64-byte seed** is synced by default, because iCloud Keychain is end-to-end encrypted and a seed that does not survive a lost phone is a product with no recovery; the **device key** is `ThisDeviceOnly` and **never synced**, because a device key in a synced keychain would make two phones one device. Not in the platform store: each paired gateway's **token**, which lives in the vault's backup ledger `<stem>.backup.db` beside the gateway's addresses, pinned certificate and writer epoch — device-local, excluded from OS backup and never synced, because a token restored onto a second phone would make two phones one writer; a phone that loses the ledger pairs again ([#1080](https://github.com/srikanth235/centraid/issues/1080)).

### App manifests — files win

| Surface | Owner |
| --- | --- |
| `crates/apps/<app>/manifest.json` | The release. Each app crate embeds its manifest with `include_str!`, so a shipped binary carries the manifest it was built with and nothing edits it at runtime |
| Consent grants, install rows | Vault runtime |

### OS service units (H5) — `centraid-gateway install` wins

| Path | Owner |
| --- | --- |
| LaunchAgent `~/Library/LaunchAgents/<label>.plist` / systemd user unit `~/.config/systemd/user/<label>.service` | `centraid-gateway install --data-dir <dir> [--bind <addr>]` |

The command creates a missing data directory with mode 0700, writes the unit and **prints** the command that starts it; it never enables it. `--dry-run` prints the unit and its path and writes nothing. Hand-edited units may be replaced on reinstall. Service install is **opt-in, default off** ([decisions.md](decisions.md) H5). `deploy/vps/install.sh` installs from a release and _offers_ a service rather than enabling one, and the container image runs `serve` itself ([deploy/README.md](../deploy/README.md)).

**Packaging / declarative modules (issue #504):** Docker, Nix flakes, and future NixOS modules must **not** become a second independent writer of the same unit files. The canonical generator is `centraid-gateway install` (use `--dry-run` as the template source). A NixOS module, if added later, must call or bit-for-bit replicate that generator's output. Declarative host config may feed **into** the generator or the `gateway` flags.

### Pairing — runtime only, on both ends

| Path | Owner |
| --- | --- |
| A pairing secret's hash, in the gateway's `state.db` | `centraid-gateway pair` mints it and `POST /v2/pair` spends it; it survives a restart until it is used or its day runs out |
| A vault's tokens and writer epoch, in the gateway's `state.db` | The running gateway, at pairing and at a claim |
| Each paired gateway's addresses, certificate, token and epoch, in the phone's `<stem>.backup.db` | The phone's core |

Do not hand-merge these mid-flight. Recovery: [recovery/pairing.md](recovery/pairing.md).

## Agent guidance

- Document new dual-write surfaces in this file in the same PR.
- If you add a CLI that rewrites a UI-owned file, say so in the command help: "overwrites Settings."
- Prefer one writer per path.

## Related

- [logs.md](logs.md) — where to look when config "disappears"
- [ARCHITECTURE.md](../ARCHITECTURE.md) — on-disk layout
