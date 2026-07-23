# Config ownership (F3)

When both a **declarative file** and a **runtime tool** (UI, IPC, CLI, HTTP) can write the same surface, one side **wins**. The other is overwritten or ignored. This pre-empts "my settings vanished" support.

## Rule of thumb

| If you care about… | Prefer |
| --- | --- |
| Reproducible / git-reviewed config | Declarative file is source of truth; runtime is a view or temporary override that re-reads the file |
| End-user preference on a single machine | Runtime (UI) owns the file; hand-editing is unsupported while the process is running |

Never claim both are durable writers without a merge strategy — Centraid does not implement general CRDT config merge.

## Surfaces

### Desktop UI settings — runtime wins

| Path | Owner | Notes |
| --- | --- | --- |
| `<userData>/centraid-settings.json` | Desktop main process / Settings UI | Active gateway pointer, builder gate, remote templates URL, per-gateway vault selection. Hand-edits while the app runs can be overwritten on next save. |

Code: `apps/desktop/src/main/settings.ts`.

### Per-gateway device prefs — runtime wins

| Path | Owner | Notes |
| --- | --- | --- |
| `<userData>/gateways/<id>/prefs.json` (desktop) or `<dataDir>/prefs.json` (daemon) | Gateway prefs API / Settings | Runner choice, bin path, theme-related device prefs, **Resource mode** (`gateway.resourceMode`: `auto` \| `conserve` \| `balanced` \| `performance`, issue #521). Not vault identity (#280). |

Declarative "dotfiles" for prefs are not a product feature; treat the JSON as owned by the running gateway. Daemon `config.json` may seed `resourceMode` when the pref is unset; env `CENTRAID_RESOURCE_MODE` wins over both for operators. The selected mode is applied at gateway serve boot (worker limits are process-scoped).

### Gateway profile (multi-gateway) — runtime wins

| Path | Owner |
| --- | --- |
| `<userData>/gateways/<id>/profile.json` | Gateway switcher / store |

### Vault ontology settings — vault commands win

| Surface | Owner | Notes |
| --- | --- | --- |
| `core_vault.settings_json` and related rows | Vault journalled commands / Settings Backup UI | Blob store mode, backup policy, etc. Direct SQL against `vault.db` bypasses consent and is unsupported. |

### App manifests — files win for code; runtime for grants

| Surface | Owner |
| --- | --- |
| Shipped / git-store `app.json`, handlers | Code store / release / Publish |
| Consent grants, install rows | Vault runtime (install sheet, revoke) |

Editing `app.json` in a draft worktree does not change production grants until Publish / install flows say so.

### Model catalog — runtime wins when file present

| Path | Owner |
| --- | --- |
| `model-catalog.json` under gateway dir | Runner status / Refresh catalog |

Omit file → enumerate without persistence. File is rewritten on refresh.

### OS service units (H5) — CLI install wins

| Path | Owner |
| --- | --- |
| LaunchAgent `dev.centraid.gateway.plist` / systemd user unit | `centraid-gateway service install` |

Hand-edited units may be replaced on reinstall. Service install is **opt-in, default off** ([decisions.md](decisions.md) H5).

**Packaging / declarative modules (issue #504):** Docker, Nix flakes, and future NixOS modules must **not** become a second independent writer of the same unit files. Canonical writer remains `centraid-gateway service install` (use `--dry-run` as the template source). A NixOS module, if added later, must call or bit-for-bit replicate that generator's output. Declarative host config (bind, dataDir, tunnel knobs) may feed **into** the generator or `serve` flags; runtime mutation of prefs stays on the gateway prefs API.

### Pairing / enrollment files — runtime only

| Path | Owner |
| --- | --- |
| `devices.json`, `pairing-tickets.json`, `device-tokens.json`, `web-sessions.json`, `endpoint.json`, `endpoint-key.bin`, `token.bin` | Daemon / pairing CLI |

Do not hand-merge these mid-flight. Recovery: [recovery/pairing.md](recovery/pairing.md).

## Agent guidance

- Document new dual-write surfaces in this file in the same PR.
- If you add a CLI that rewrites a UI-owned file, say so in the command help: "overwrites Settings."
- Prefer one writer per path.

## Related

- [logs.md](logs.md) — where to look when config "disappears"
- [ARCHITECTURE.md](../ARCHITECTURE.md) — on-disk layout
