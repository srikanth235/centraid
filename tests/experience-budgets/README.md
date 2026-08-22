# Experience budgets (issue #659 R2)

One file per shipping surface, written in **what the vault owner feels** — not in what the machine spends. A ceiling here answers "how long until I can use it", never "how many bytes did we transfer". The byte/request/CPU ceilings still exist and still gate; they live in [`apps/web/tests/e2e/perf-budgets.ts`](../../apps/web/tests/e2e/perf-budgets.ts), [`packages/server/benchmarks/low-end-budgets.json`](../../packages/server/benchmarks/low-end-budgets.json) and [`tests/quality-rig-budgets.json`](../quality-rig-budgets.json). This directory is the layer above them: the same regressions, stated as symptoms.

| File                           | Surface                                   |
| ------------------------------ | ----------------------------------------- |
| [`web.json`](web.json)         | Installable PWA (`apps/web`)              |
| [`desktop.json`](desktop.json) | Electron desktop (`apps/desktop`)         |
| [`mobile.json`](mobile.json)   | Expo iOS/Android (`apps/mobile`)          |
| [`gateway.json`](gateway.json) | Perceived latency of gateway-backed flows |

All four are registered in `PERF_BUDGET_SOURCES` ([`scripts/test-report/ratchet-floors.mjs`](../../scripts/test-report/ratchet-floors.mjs)), so every `*Ms` / `*Bytes` / `max*` number is **tighten-only** and every `min*` number is **raise-only** against the merge base. Widening one requires an `approvedDeviation` string in the file.

## The five perceived-latency verbs

Every metric in every file is one of these. If a new number is not one of them, it is a machine-cost budget and belongs in one of the files above instead.

| Verb | Key stem | What the owner experiences |
| --- | --- | --- |
| **cold open → first usable screen** | `coldOpenToUsableMs` | Tapped the icon on a cold process; how long until they can act, not until pixels exist |
| **tap → visual response** | `tapToVisualResponseMs` | Any deliberate input acknowledged by a frame that changed |
| **chat send → first token** | `sendToFirstTokenMs` | Pressed send; how long the composer sits dead |
| **scroll frame-drop ceiling** | `maxDroppedFramePercent` | Fraction of frames missed while flinging a long list |
| **sync staleness after reconnect** | `reconnectToFreshMs` | Reopened the app / regained network; how long the screen lies |

## Provenance is part of the budget

Every metric carries a `status`, and the reviewer is entitled to trust it:

| `status` | Means |
| --- | --- |
| `measured` | A real run on the stated date/host produced `_provenance.observed*`; the ceiling is that value plus the stated headroom |
| `projected` | Arithmetic on a measured number from a _different_ volume or surface. `_basis` names the measurement it extrapolates from. Never presented as observed |
| `unmeasured` | **No number.** The ceiling key is absent. `probe` names the rig that will fill it, and until then nothing gates |

A ceiling that is known but not yet observable is parked as `_intendedCeilingMs` — the leading underscore is invisible to the ratchet and to every consumer, so it documents intent without gating on a number the probe cannot produce.

An `unmeasured` entry deliberately has no `ceilingMs`. Landing a plausible number with no run behind it is the failure this field exists to prevent — a budget nobody measured is indistinguishable from a budget nobody meets.

## Year-3 declared volumes (D6)

Every ceiling in this directory is stated **at a volume**. A ceiling with no volume is not a budget. These are the repo's declared year-3 numbers for a single personal vault, and they are the same ones the nightly scale rigs seed to — see the `volume` string on each entry in [`tests/quality-rig-budgets.json`](../quality-rig-budgets.json).

| Dimension | Year-3 volume | Rig that seeds it |
| --- | --- | --- |
| Photo assets | 90,000 (3,000 near-duplicate families) | `tests/scale/phash-clustering.scale.test.ts` |
| Photos in the daily-use path | 10,000 | `tests/scale/large-vault.scale.test.ts` |
| Contacts / people | 5,000 | `tests/scale/large-vault.scale.test.ts` |
| Notes | 1,000 | `tests/scale/large-vault.scale.test.ts` |
| Conversation turns | 7,300/yr → ~22,000 | `tests/scale/conversation-ledger.scale.test.ts` |
| Ontology entities | 10,000 | `tests/scale/ontology.scale.test.ts` |
| CAS objects | 100,000 | `tests/scale/blob-gc.scale.test.ts` |
| Automations | 200 | `tests/scale/automations-fire.scale.test.ts` |
| Replica rows on a phone | 50,000 | `tests/scale/replica-bootstrap.scale.test.ts` |
| Vault on disk | 10 GiB | `tests/scale/restore-10gib.scale.test.ts` |
| Paired devices | 200 | `tests/scale/tunnel-pairs.scale.test.ts` |
| Mounted vaults on one gateway | 5 | `tests/scale/multi-vault-footprint.scale.test.ts` |

**A budget measured on an empty vault is labelled `"volume": "empty"`** — it is a bundle/transport ratchet only and cannot catch an O(vault-size) regression. Several entries here are honestly in that state today; each says so.

## Measured provenance already on the record

Numbers other #659 agents produced on real runs, cited rather than re-derived:

| Measurement | Value | Source |
| --- | --- | --- |
| 90k-asset perceptual-hash cold sweep | 9.0 s | `tests/scale/phash-clustering.scale.test.ts` (2026-07-31, darwin arm64) |
| …idle incremental sweep | 145 ms | same rig, same run |
| 100k mixed-custody CAS objects, GC sweep | under a 60 s budget | `tests/scale/blob-gc.scale.test.ts` (2026-07-31) |
| Backup manifest growth | 205 bytes per chunk-index entry | `tests/scale/backup-manifest-size.scale.test.ts` (2026-07-31) |
| **Year-3 restore (10 GiB)** | **55.4 s** (snapshot 152.4 s) | `tests/scale/restore-10gib.scale.test.ts` (2026-07-31, darwin arm64 NVMe) |
| …`foreign_key_check` alone, 95,640 rows | 21.2 ms | same rig, same run |
| …`integrity_check` alone | 784.9 ms | same rig, same run |
| Desktop cold launch → usable Home | 4.54 s (4.49 s of it main-process boot) | `apps/desktop/tests/e2e/launch-time.spec.ts` (2026-07-31, darwin arm64) |
| Desktop tap → app view attached | 2.07 s | same spec, same run |
| Desktop renderer shipped weight | 5.83 MB across 33 files (largest 1.33 MB) | `scripts/perf/app-weight.mjs --surface desktop` (2026-07-31) |
| **5-vault page-cache reservation** | **32,768,000 B** (was 163,840,000 B per-file) | `tests/scale/multi-vault-footprint.scale.test.ts` (2026-07-31) |
| …RSS per additional mounted vault, idle | 10.1 MB | same rig, same run |
| Mobile `expo export` shipped weight | 11.60 MB iOS / 11.60 MB Android (Hermes bundle 6.36 MB) | `scripts/perf/app-weight.mjs --surface mobile` (2026-07-31) |
| **Gateway send → first token, dead time only** | **p95 123 ms** contended / 53 ms idle (median 48–70 ms) | `scripts/perf/send-to-first-token.mjs` (2026-08-21, linux x64) — spawn + ACP handshake + prompt dispatch only; excludes the HTTP/SSE route, every client, and the provider's own time. A **lower bound** on the owner's interval, not the whole of it |

## Changing a number

1. Re-run the `probe` named on the entry.
2. Put the observed value in `_provenance` with `at` (ISO date) and `host`.
3. Set `ceilingMs` to observed + the headroom you state in `_provenance.headroom`.
4. If the value **dropped**, tighten. The ratchet will not let you widen without `approvedDeviation`, and that is the point.
