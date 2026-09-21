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

One layout, stated in [`crates/centraid/src/cmd/mod.rs`](../crates/centraid/src/cmd/mod.rs):

| Path | Owner | Notes |
| --- | --- | --- |
| `<data-dir>/vault/<vaultId>/vault.db` | `centraid gateway`, the vault's one writer | Enrolled devices live here (`access_device`, `access_device_secret`). Direct SQL bypasses the command plane and its receipts, and is unsupported while the gateway runs |
| `<data-dir>/keys/*` | `KeyStore` ([`crates/vault/src/custody`](../crates/vault/src/custody/README.md)) | Atomic `0600` envelopes. Export, backup and copy gestures never move this directory |
| `<data-dir>/blobs/` | `centraid backup now` / `centraid recover` | The backup plane's content-addressed store |

Operator inputs are flags and environment, read at start: `--data-dir`, `--vault-name`, `--relay` / `--no-relay`, `--print-qr`, `--log` / `CENTRAID_LOG`, and `CENTRAID_EXPECTED_CORE_DIGEST` (a shell's claim about which core it was built against; a mismatch is refused). There is no gateway config file and no prefs store.

### Vault ontology settings — vault commands win

| Surface | Owner | Notes |
| --- | --- | --- |
| `core_vault.settings_json` and related rows | Journalled vault commands | The seal-key fingerprint is stamped here inside the sealing transaction. Direct SQL against `vault.db` bypasses consent and is unsupported |
| `enrich_policy` | Vault founding ([`crates/vault/src/bootstrap.rs`](../crates/vault/src/bootstrap.rs)) | Seeded `gateway` for `photos` and `docs`; no command in this build changes it, and Photos reads it without being able to set it |

### Desktop — the Electron main process wins

| Path | Owner | Notes |
| --- | --- | --- |
| `<userData>/vaultdata/` | The `centraid seat` sidecar the main process spawns (`--data-dir`) | The seat's replica. `CENTRAID_DATA_DIR` overrides the path |
| `<userData>/seat.sock` | The sidecar | Unix socket, mode 0600, peer-uid checked. `CENTRAID_SEAT_SOCKET` overrides the path |
| `<userData>/seat.nonce` | The main process, rewritten on every spawn | Mode 0600; a file rather than a flag so it is in no `ps` listing |
| `<userData>/install-id` | The updater's rollout bucket | Stable per install |

Code: [`desktop/electron/src/main.ts`](../desktop/electron/src/main.ts), [`desktop/electron/src/main/sidecar.ts`](../desktop/electron/src/main/sidecar.ts).

### Mobile — the platform secure store wins

One enrollment record per vault — the device's private identity key, the vault id, dialling hints — in the platform store, written and moved as one unit ([`Enrolments.kt`](../mobile/shared/src/commonMain/kotlin/dev/centraid/shared/shell/Enrolments.kt)). The replica file is named by the vault id.

### App manifests — files win

| Surface | Owner |
| --- | --- |
| `crates/apps/<app>/manifest.json` | The release. Each app crate embeds its manifest with `include_str!`, so a shipped binary carries the manifest it was built with and nothing edits it at runtime |
| Consent grants, install rows | Vault runtime |

### OS service units (H5) — `centraid gateway install` wins

| Path | Owner |
| --- | --- |
| LaunchAgent `dev.centraid.gateway.plist` / systemd user or system unit | `centraid gateway install [--system --instance <name>]` |

The command writes the unit and **prints** the command that enables it; it never enables it. `--dry-run` prints the unit and writes nothing. Hand-edited units may be replaced on reinstall. Service install is **opt-in, default off** ([decisions.md](decisions.md) H5). The committed templates under [`deploy/`](../deploy/README.md) (`launchd/`, `systemd/`) and `deploy/vps/install.sh` are for hosts that install from a release.

**Packaging / declarative modules (issue #504):** Docker, Nix flakes, and future NixOS modules must **not** become a second independent writer of the same unit files. The canonical generator is `centraid gateway install` (use `--dry-run` as the template source). A NixOS module, if added later, must call or bit-for-bit replicate that generator's output. Declarative host config may feed **into** the generator or the `gateway` flags.

### Pairing and enrollment — runtime only

| Path | Owner |
| --- | --- |
| Enrolled devices in `vault.db` | The running gateway, through the vault's device methods ([`crates/vault/src/devices.rs`](../crates/vault/src/devices.rs)) |
| Pair tickets | The running gateway's memory only; a restart invalidates them |
| `<data-dir>/keys/gateway.endpoint.key` | The gateway, created on first start with `--data-dir` |

Do not hand-merge these mid-flight. Recovery: [recovery/pairing.md](recovery/pairing.md).

## Agent guidance

- Document new dual-write surfaces in this file in the same PR.
- If you add a CLI that rewrites a UI-owned file, say so in the command help: "overwrites Settings."
- Prefer one writer per path.

## Related

- [logs.md](logs.md) — where to look when config "disappears"
- [ARCHITECTURE.md](../ARCHITECTURE.md) — on-disk layout
