# `crates/automations`

The fire spine, the triggers, the enrichment gate and the recognition recipes ([#1020](https://github.com/srikanth235/centraid/issues/1020), inventory row _automations — retain_).

One sentence: **decide what should run, and hand it to somebody else to run.** This crate schedules (in the vault's zone), walks cursors, refuses what a member has not consented to, and steers a delegate through exactly one injected seam. It opens no socket, spawns no process, holds no SQL and reaches no harness.

## Modules

| Module | What it owns |
| --- | --- |
| `manifest` | `automation.json`: five trigger kinds, the enrich block, the sandbox declaration, and the four couplings a shape check alone would miss |
| `watch` | which entities a trigger may watch, as a **structural** rule |
| `cron` | civil time in the vault's zone, with v0's host-clock tier deleted |
| `fire` | the spine, the cursor engine, the enrichment gate, the missed-run ledger, steering |
| `handler` | provenance tiers, the target-failure caps, the `Model` trait, the recipe catalogue |
| `webhook` | the ingress door, without a listening socket |
| `anchor` | the `@[…]` grammar and the consent scopes it collapses to |
| `signals` | what a member is told when any of the above refuses |

## Four boundaries, and where each is written down

1. **One injection point.** `fire::Steering` takes `&dyn centraid_assist::turn::Dispatch`. There is no other route to a harness (`fire/fire.ts:1`–`:3`), and the dependency runs one way: automations calls the trait, assist implements it, assist depends on this crate for nothing.
2. **No listening socket.** A webhook is inbound HTTP and the product has no listener, so a delivery arrives through a seat — `centraid automations deliver <id>` with the payload on stdin, or the gateway's iroh endpoint from a paired phone.
3. **No SQL.** Every store is a trait (`fire::cursor::CursorStore`, `fire::scheduler_ledger::LedgerStore`, `webhook::IngressStore`); the statements live in `centraid_vault::ledger::automation_*`.
4. **No model client.** `handler::Model` is the seam. Real inference is an owner hand-off per model — see below — never a stub that reads green.

## Cron resolves in **two** tiers

v0 resolves a fire zone in three: the trigger's `tz`, a gateway-wide preference, then the host clock. The third is deleted ([`docs/cron-timezone.md`](../../docs/cron-timezone.md), R-1020-33): on a VPS it silently becomes UTC, so a member in Bengaluru gets their morning digest at half past noon and nothing says why. v1 resolves the trigger's `tz`, then **the vault's zone**, then refuses with a typed `ZoneUnset` raised as a system signal.

**The host's zone is unreachable by construction**, not by convention: `jiff` is depended on with `default-features = false` and without `tz-system`, so no code path — ours or the library's — can read `TZ` or `/etc/localtime`. The zone database is `tzdb-bundle-always`, compiled in, so the answer does not depend on whether a container image shipped `tzdata`.

## The models are an owner hand-off, one per model

`handler::Model` is one method: bytes in, a typed result out. The real implementations are `ort` sessions, and **none of them is in this crate**. Each is a hand-off with its exact command and the evidence it needs. The weights themselves are already ported — `centraid_media::models` verifies from disk and fetches only what is missing, and `handler::NoNetwork` proves that a host with no network is reported rather than thrown.

| Capability | Model | Size | The command, and the evidence |
| --- | --- | --- | --- |
| `faces` (detect) | YuNet, OpenCV Zoo 2023mar | 0.2 MB | `bun run --cwd packages/model-runtime setup --capability faces`, then a run over a fixed frame set reporting boxes within a stated IoU of v0's |
| `faces` (recognise) | ArcFace ResNet100 | 249 MB | the same run, reporting 512-d vectors whose same-person pairs sit below `enrich`'s party threshold |
| `photo-ocr` | PP-OCRv5 mobile det + rec | 21 MB | a run over a fixed page set whose extracted text matches v0's character for character |
| `embed-image`, `embed-text` | CLIP ViT-B/32 | 606 MB | a run over one image and its caption whose cosine similarity is above v0's |
| `transcript` | Whisper tiny.en q8 | 41 MB | a run over one 30-second clip matching v0's transcript |
| the network fetcher | — | — | one run against the real upstreams reporting `ready` for `faces`, and one against a deliberately corrupted local file reporting the sha mismatch and leaving no `.partial` behind |

`place-names` needs no hand-off: it reads a coordinate, its knowledge is a vendored GeoNames table, and the lookup is arithmetic.

## The fixtures

`contracts/automations/` is generated from the live v0 modules by `contracts/tools/export-automations-parity.ts`, and `tests/quality/automations-parity.contract.test.ts` is both the emitter and the v0-side oracle:

```sh
CENTRAID_WRITE_CONTRACTS=1 node node_modules/vitest/vitest.mjs run \
  tests/quality/automations-parity.contract.test.ts
bun run format && git diff --exit-code contracts/automations
```

`crates/automations/tests/parity.rs` compares this crate's answers against every case. `cron-cases.json` is the matcher's whole truth table — 10,320 cases over five zones — and it carries one `finding` block recording what v0 answers with no zone at all on a UTC host, which is the one case where agreeing with v0 would be the bug.

## Related

- [civil time and cron timezone](../../docs/cron-timezone.md) · [recognition automations](../../docs/recognition-automations.md) · [system signals](../../docs/system-signals.md)
- [`crates/assist`](../assist) — the `Dispatch` trait, the posture and the ledger
- [`crates/vault/src/ledger`](../vault/src/ledger) — the statements over `automation_state`, `automation_trigger_cursor` and `trigger_ingress`
