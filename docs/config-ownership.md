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
| `<userData>/centraid-settings.json` | Desktop main process / Settings UI | Active gateway pointer, remote templates URL, per-gateway vault selection. Hand-edits while the app runs can be overwritten on next save. |

Code: `apps/desktop/src/main/settings.ts`.

### Per-gateway device prefs — runtime wins

| Path | Owner | Notes |
| --- | --- | --- |
| `<dataDir>/gateway.db` preferences table | Gateway prefs API / Settings | Harness choice, bin path, theme-related device prefs, and Resource mode. Desktop, CLI, and OS service use the same platform-default data dir. |

Declarative "dotfiles" for prefs are not a product feature; treat the JSON as owned by the running gateway. Daemon `config.json` may seed `resourceMode` when the pref is unset; env `CENTRAID_RESOURCE_MODE` wins over both for operators. The selected mode is applied at gateway serve boot (worker limits are process-scoped).

The resolved profile is published on the health metrics surface (`GET /centraid/_gateway/health` → `metrics.resourceProfile`, issue #528 Phase A): host class, owner mode, detected host facts, and every resolved knob (worker/replication/sqlite/sweep). It is a read-only projection of the boot resolution — nothing writes back through it.

Baseline inputs now describe the **granted share of the host, not the raw machine** (issue #528 Phase E). At serve boot the gateway additionally probes the cgroup CPU quota (`cpu.max` / `cpu.cfs_quota_us`) and memory limit (`memory.max` / `memory.limit_in_bytes`) plus one cumulative CPU-steal sample, and feeds them into the **same single resolver**. A container capped below the machine, or a VM losing significant CPU to steal, sizes down to the share it actually keeps; an unconstrained host resolves to the same numbers as before. Resource modes are budget presets over that share (`resourceProfile.budget.cpuShare` / `budget.memoryCapMb`, additive). These probes are failure-tolerant read-only host reads — they never write config and never trade SQLite durability, which stays FULL unless the owner explicitly opts into NORMAL (`CENTRAID_SQLITE_SYNCHRONOUS` or Conserve mode).

**Experimental feature gate (v0, issue [#774](https://github.com/srikanth235/centraid/issues/774)).** Two prefs keys — `gateway.experimental.automations` and `gateway.experimental.connectors` (booleans; absent means off) — opt a gateway into the experimental surfaces. Written through the generic prefs API; the gateway reads them at serve boot through the one `resolveExperimentalFeatures` resolver. Precedence is env &gt; prefs &gt; host option: `CENTRAID_EXPERIMENTAL` (comma-separated feature names) is authoritative for **every** feature when set at all, matching the `CENTRAID_RESOURCE_MODE` contract. Daemon `config.json` may seed the same gate under an `experimental` object (`{"experimental": {"automations": true}}`), which the prefs keys and the env var both override. Changes apply on the next serve boot. Turning a feature off never deletes its durable data.

**Engine profiles are gateway prefs, never vault rows (issue [#807](https://github.com/srikanth235/centraid/issues/807)).** A user-created enrichment engine profile — a capability bound to a harness, a model, config pins and a prompt revision — is written to one prefs key per profile, `enrich.profile.<id>`, whose value is a JSON object (`{capability, label?, harness, model?, configPins?, promptRev?}`). Every binding in it is gateway/device configuration, so this is the only writer; the vault stores which profile PRODUCED a value (`enrich_derivation.profile`) and whether an egress class was consented to (`enrich_consent`), never the binding. The **built-in profile of each capability is derived, not stored** — `packages/server/src/enrich/engine-profiles.ts` computes it from the capability registry on every read, so a profile that shadows the reserved id `built-in` is refused. Writes go through the generic prefs API and are gated by that module's `validateEngineProfilePatch` in the prefs route's `validatePatch` hook (first offending key → 409 with the member-facing reason); the read surface `GET /centraid/_enrich/profiles` never writes. The **egress class is computed from the engine and is not a settable field** — a patch that carries one is rejected.

**Background pause is runtime-only, never a durable mode flip.** `POST`/`DELETE /centraid/_gateway/resource/pause` (issue #528 Phase B) hot-applies an owner "pause background work" window that gates only the safe loops (vault sweeps, backup retention) — never WAL/fsync durability, the consent outbox, or request-path work. It lives **in memory on the running gateway** (a restart resumes normally) and is deliberately **never persisted to prefs** and **never changes `gateway.resourceMode`**: the durable Resource mode and the transient pause are independent surfaces with no write-back between them.

**Durable per-knob overrides sit above the mode preset (issue #528 Phase F).** Four prefs keys let the owner pin an individual throughput knob without leaving the Resource mode's budget: `gateway.resource.workerMaxConcurrent`, `gateway.resource.workerMaxOldGenerationMb`, `gateway.resource.workerPoolSize`, `gateway.resource.replicationConcurrency` (positive integers; an absent key means **Linked** to the preset). The client writes them through the generic prefs API — the gateway only **reads** them at serve boot and resolves each knob through the **ONE** `resolveGatewayHardwareProfile` resolver, never a second policy path. Precedence per knob is **env > prefs > preset** (a matching `CENTRAID_*` env var still wins and reads as env-locked). Prefs values clamp through the same bounds as the env var; garbage (strings, negatives, floats) is dropped. Knob changes are durable and **apply on the next serve boot** — identical to Resource mode; the running-vs-desired story is the client comparing `metrics.resourceProfile` against the saved prefs. The structured profile additionally publishes `resourceProfile.sources` (per-knob `env`/`prefs`/`preset` provenance, with the exact `envVar` when env-locked) and `resourceProfile.bounds` (per-knob min/max) so the client renders Linked/Custom/env-locked and validates input without duplicating magic numbers.

### Gateway profile (multi-gateway) — runtime wins

| Path | Owner | Notes |
| --- | --- | --- |
| `<userData>/connections.json` | Desktop main process / Gateway → Components → Connections | One non-secret row per EndpointId; relay hints are refreshable cache. |
| `<userData>/connection-secrets.bin` | Desktop main process / OS `safeStorage` | Per-connection device keys; never renderer storage. |

### Vault ontology settings — vault commands win

| Surface | Owner | Notes |
| --- | --- | --- |
| `core_vault.settings_json` and related rows | Vault journalled commands / Settings Backup UI | Blob store mode, backup policy, etc. Direct SQL against `vault.db` bypasses consent and is unsupported. |

### App manifests — files win for code; runtime for grants

| Surface | Owner |
| --- | --- |
| Bundled system app `app.json`, handlers | The release — shipped source in `packages/blueprints/apps/`, never editable at runtime |
| Cloned automation `app.json`, handlers | The vault's `code/` store, via the clone + publish flow |
| Consent grants, install rows | Vault runtime (install sheet, revoke) |

Editing a cloned automation's `app.json` in a draft worktree does not change production grants until the publish / install flows say so.

### Model catalog — runtime wins when file present

| Path                                   | Owner                            |
| -------------------------------------- | -------------------------------- |
| `model-catalog.json` under gateway dir | Harness status / Refresh catalog |

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
| `gateway.db` (`devices`, `tickets`, `web_sessions`, backup/storage state) | The lock-holding gateway daemon; stopped-daemon CLI commands may open it explicitly |
| `<dataDir>/keys/*` | `KeyStore`; desktop supplies `safeStorage`, headless uses atomic `0600` envelopes |
| `<userData>/connections.json` + `connection-secrets.bin` | Desktop main process only; renderer localStorage owns neither connection records nor credentials |

Do not hand-merge these mid-flight. Recovery: [recovery/pairing.md](recovery/pairing.md).

## Agent guidance

- Document new dual-write surfaces in this file in the same PR.
- If you add a CLI that rewrites a UI-owned file, say so in the command help: "overwrites Settings."
- Prefer one writer per path.

## Related

- [logs.md](logs.md) — where to look when config "disappears"
- [ARCHITECTURE.md](../ARCHITECTURE.md) — on-disk layout
