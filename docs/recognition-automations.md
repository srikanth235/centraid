# Recognition automations

OCR, transcription, image/text embeddings, and faces are bundled automations whose handlers own model execution.

## Three provenance tiers

**"System" is a provenance tier, and it means the same thing for a bundled automation as it does for a bundled app**: shipped with the release, first-party code authored in this repo, present in every vault, upgraded with the release, on by default, and executed with the same trust as the rest of [`packages/server`](../packages/server). Bundled blueprint apps already run as first-party shell code rather than in the third-party sandbox; the recognition automations that _are_ the photos and documents pipelines are the same kind of code, and now run the same way.

| Tier | Members | Armed by | Sandbox lane |
| --- | --- | --- | --- |
| **System** | `faces`, `photo-ocr`, `doc-text-extractor` | the release catalogue, every boot — no `enabled` flag is read | `system` |
| **Bundled-optional** | `embed-image`, `embed-text`, `transcript`, `place-names` | the row's own `enabled` bit, off until the member turns it on | the lane the manifest declares (`model-runtime`, `media-transcode`, or the floor) |
| **External** | code-store automations, future | the same `enabled` bit | the floor, or a declared lane |

Membership is [`packages/server/src/enrich/system-recognition.ts`](../packages/server/src/enrich/system-recognition.ts) — two constants, `SYSTEM_AUTOMATION_IDS` and `BUNDLED_OPTIONAL_AUTOMATION_IDS`. Every id in either list is **reserved** against code-store apps (`isBundledAppId` in `serve/build-gateway.ts`), so a member app can never take one of these names and inherit its tier.

### Lane routing is keyed to provenance, never to a declaration

The lane a handler runs in is decided by the **parent**, at fire time, from the automation's id against that constant ([`automation/fire/fire.ts`](../packages/server/src/automation/fire/fire.ts), `sandboxRequest`). A system automation's `sandbox.lane` field is not consulted at all, and nothing a handler or a manifest says can reach the system lane: the manifest parser accepts only `model-runtime` and `media-transcode` there. Widening the system tier is an edit to a constant in this repository, in a pull request, and nothing else.

The `system` lane ([`engine/sandbox/policy.ts`](../packages/server/src/engine/sandbox/policy.ts)) grants every builtin, the real `node:fs`, subprocesses, native addons and the process environment — which is to say it grants **nothing the gateway process does not already have**. That is the honest description of first-party release code running in-thread, and it is why the change is a routing change rather than a widening: the existing sandbox stays exactly as strict as it is today for everything that is not first-party system code, and the property being preserved is that _nothing the owner did not ship in the release ever gains a wider lane_.

The concrete failure this fixes: `sharp`, pulled in by the recognition runtime, requires `node:child_process` at load through `detect-libc`. The static conformance suite cannot see it — it reads the shipped bundle, not the runtime's own dependency graph — so `faces` and `photo-ocr` refused on first fire with `sandbox refused: builtin "node:child_process" is not in lane "model-runtime"'s allowlist`. [`bundle-lane-conformance.test.ts`](../packages/server/src/engine/sandbox/bundle-lane-conformance.test.ts) now asserts that same require is admitted in the `system` lane and still refused in `model-runtime` and at the floor, so the boundary for optional and external code is demonstrably unmoved.

### System means on

A system automation has no `enabled` question to answer. Install writes the catalogue's flag on every boot rather than preserving a per-vault bit (`ensureSystemRecognitionRecipe`), and the scheduler reconcile arms every system row unconditionally — the release decided that it runs, so there is no per-vault answer to keep and no drift to inherit. A bundled-optional recipe keeps today's semantics exactly: the manifest default for a row that does not exist yet, the member's own answer forever after.

**Paused is not disabled.** The owner's transient background pause is a run-state, honoured at _fire_ time (`fireAutomation`), never by dropping the registration — a registration dropped at reconcile would not come back when the pause lifted, and the recipe would silently stay dead. A manual run is never paused: the owner asking is the answer.

### Consent is for egress

For a system automation the only decision left to the member is the **cloud tier**. Egress leaves their trust domain and needs consent; on-device work over their own bytes on their own gateway needs none. So an unreadable or unwritten enrichment policy no longer refuses a system fire — it resolves to enabled-on-device, and the run proceeds with `ctx.delegate` sealed ([`automation/fire/enrich-resolve.ts`](../packages/server/src/automation/fire/enrich-resolve.ts), [`enrich-gate.ts`](../packages/server/src/automation/fire/enrich-gate.ts)). Every ceiling above that is untouched: an explicit `off` still refuses, a rule that switches the capability off still refuses, and the egress-consent ledger still decides every provider turn. A system automation gets no wider _reach_ than any other — it gets a floor, not a ceiling.

`enrich_request` is a **priority hint, never a gate**. The queue says which target to do first inside a bounded batch; it has never been what makes the work run, and with recognition armed from the catalogue it cannot become that by accident. A recipe with an empty queue still walks the library behind its cursor.

## One handler, one execution boundary

Each recognition handler owns its complete recognition flow. It:

1. selects a bounded batch from the vault;
2. reads source material with `ctx.vault.content`;
3. runs its model implementation in the handler worker, loading pinned third-party libraries and model assets from the shared local recognition runtime when needed;
4. persists the canonical result through a typed `ctx.vault.invoke` command; and
5. advances its cursor and stamps `enrich_derivation` with the model/version that produced the result.

There is no enrichment HTTP service, gateway model client, reserved `centraid://enrichment/*` fetch, `ctx.enrich`, or `ctx.infer`. `ctx.fetch` remains connector-only. Apps do not call models: they enqueue consent-scoped work when required and read the projections the automations populate.

The source modules live under [`packages/model-runtime/automation-handlers`](../packages/model-runtime/automation-handlers) for build-time reuse. [`build-automation-handlers.ts`](../packages/model-runtime/build-automation-handlers.ts) bundles Centraid-authored modules into each shipped blueprint handler under [`packages/blueprints/automations`](../packages/blueprints/automations). Large third-party packages such as PDF.js remain in the single version-locked recognition runtime rather than being duplicated into handler source.

## Content and result flow

| Template | Content read | Result command | Local implementation |
| --- | --- | --- | --- |
| `embed-image` | photo preview bytes | `enrich.upsert_embedding` | CLIP visual tower |
| `embed-text` | vault text | `enrich.upsert_embedding` | CLIP text tower |
| `photo-ocr` | photo/scan preview bytes; capture image or PDF bytes | `core.set_extracted_text` | PP-OCRv5; PDF text layer first, rendered-page OCR fallback |
| `faces` | photo preview bytes | face-region and embedding commands | YuNet + ArcFace (512-d) |
| `transcript` | bounded original audio/video bytes | `core.set_extracted_text` (`transcript`) | local FFmpeg decode + Whisper tiny.en q8 |
| `place-names` | a place row's own stored coordinate — no media bytes at all | `media.set_place_gazetteer` | vendored GeoNames `cities15000` table, nearest-settlement lookup in the handler |

### The models

Weights are **release assets, not repository content**: [`packages/model-runtime/models.lock.json`](../packages/model-runtime/models.lock.json) is the manifest and every file in it is pinned by sha256, byte length and an immutable upstream URL. `ensureModelAssets` ([`src/model-assets.ts`](../packages/model-runtime/src/model-assets.ts)) is the one implementation that reads that manifest, verifies what is on disk and fetches only what is missing or altered — into a temp file, renamed only after its digest matches. The `setup` script is a thin CLI over it and the gateway calls it at first boot for the capabilities it is provisioning; a capability whose upstream is unreachable is reported, never thrown, and its automation simply stays unavailable until the next boot. Nothing outside the requested capabilities is read or written.

| Capability | Model | Pinned as | Licence | Approx. size | Why this one |
| --- | --- | --- | --- | --- | --- |
| `faces` (detection) | YuNet (OpenCV Zoo, 2023mar) | `yunet-arcface@1` | MIT | 0.2 MB | Five-point landmarks in one 640×640 pass, which is what makes ArcFace alignment possible at all; small enough to run on every ingested photograph. |
| `faces` (recognition) | ArcFace ResNet100 (ONNX Model Zoo `arcfaceresnet100-8`) | `yunet-arcface@1` | Apache-2.0 | 249 MB | 512-d additive-angular-margin embeddings. **Superseded SFace in [#1011](https://github.com/srikanth235/centraid/issues/1011)**: SFace's 128-d vectors put same-person and different-person pairs close enough together that party matching and stranger clustering had to share one nervously-tuned threshold. InsightFace's stronger `buffalo_l`/`w600k_r50` was rejected on licence — its model zoo permits non-commercial research use only, and every model Centraid ships is Apache-2.0 or MIT. |
| `photo-ocr` | PP-OCRv5 mobile det + rec (PaddleOCR) | `pp-ocrv5@1` | Apache-2.0 | 21 MB | **Superseded PP-OCRv4 `ch` in [#1011](https://github.com/srikanth235/centraid/issues/1011)**: one recognition head now covers simplified and traditional Chinese, English and Japanese, where v4's `ch` head read Latin text as a side effect of its training set. The pipeline shape is unchanged — DBNet probability map, 3×48×W CTC head, blank at class 0 — so the upgrade is weights, the v5 dictionary, and the recognizer's own `(x/255 − 0.5)/0.5` normalization, which PaddleOCR applies to recognition and not to detection. |
| `embed-image`, `embed-text` | CLIP ViT-B/32 (OpenAI) | `clip-vit-b-32@1` | MIT | 606 MB | One shared space for photographs and the words used to search for them. |
| `transcript` | Whisper tiny.en, int8 ONNX | `whisper-tiny.en-q8@1` | MIT | 41 MB | The largest Whisper that transcribes faster than real time on a laptop CPU without a GPU. |

A model id change is a **model bump**, not a migration: `enrich_derivation` stamps carry the id, so a vault that already holds `yunet-sface@1` or `pp-ocrv4@1` rows re-derives them behind the recipe's own bounded batch cursor. Face embeddings are compared only within one `enrich_embedding.model`, so 128-d and 512-d rows never meet.

Image-domain recipes use the thumbnail/preview derivative rather than a full-resolution original. Transcription is the deliberate exception because a shortened recording loses content, not merely resolution. Every read has a byte ceiling and an unavailable or oversized input is recorded honestly.

**A recipe skips an asset whose preview has not landed; it never fails on one.** Display rungs are contributed at ingest and backstopped by the sweep ([derived ledger](photos/derived-ledger.md)), so between an asset's arrival and its rungs there is a window where `ctx.vault.content` has nothing to hand back. That is _not ready_, not a failure: `faces`, `photo-ocr` and `embed-image` count it as `notReady` in the turn summary — separately from `skipped` — write **no** `enrich_derivation` stamp so the asset stays eligible, and continue with the rest of the batch. Because every walk is ordered by `asset_id`, a cursor pass **parks its watermark on the last asset before the first unready one** rather than advancing past it: nothing else would come back for an unstamped asset (the prior-stamp sweep only revisits assets that already carry a stamp), so advancing would drop it from every future tick. A targeted `enrich_request` for an unready asset is likewise left undrained, so the queue itself carries the retry. Throwing here was the old behaviour and it stalled the whole library on the first unready photograph, tick after tick ([#1011](https://github.com/srikanth235/centraid/issues/1011)).

**Pending and unsupported are different answers, and only one of them parks.** `ctx.vault.content` returns the same silence for a rung still in flight and for an original the raster codec **declined** — an iPhone HEIC the pinned libheif build has no decoder for, say. Parking behind the second kind is fatal rather than patient: the rung is never coming, so the watermark freezes in front of it and the rest of the library is never walked again. The vault therefore records the decline durably, as the `preview` × `previews` derivation stamp the [derived ledger](photos/derived-ledger.md#preview-unsupported-the-durable-decline) describes, and each recipe asks for it in exactly the case where it matters — no preview bytes came back. **Unsupported** counts as `skipped`, logs `no preview this codec can produce`, and the cursor **advances past it**; a targeted `enrich_request` for one is drained rather than retried. **Pending** keeps today's parking. No `enrich_derivation` stamp is written for a skipped-unsupported asset in either case: the recipe never looked at the photograph, and a `{count: 0}` faces stamp or an empty OCR row would claim that it did. Re-derivation when a codec gains a format is therefore the vault's job, not the recipe's: the marker is keyed by codec version, so the backstop re-evaluates the marked set on a bump and the ambient walk finds a previewable asset with no stamp waiting for it.

Text embeddings are keyed to their parent content item but sourced from a versioned text or transcript derivative. Their derivation stamp therefore records the source `derivative_id` as `source_version`; `embed-text` treats an embedding as current only when both the model and source version match. Rewriting text under the same embedding model replaces the stored vector instead of leaving semantic search on stale text.

`place-names` is the odd one out of that table and worth stating plainly: it recognises nothing about the member's bytes. Its input is a coordinate a photograph already carried, its knowledge is a table of settlements bundled with the automation, and its output is a settlement name written into `core_place.address_json` — never into `core_place.name`, because **a member-entered name is authoritative and derived data may not overwrite it** (issue #816). It is **bundled-optional**: shipped in the release, listed in Settings → Enrichment, and off until the member turns it on, at which point reconciliation honours the row's own `enabled` flag — a disabled recipe holds no scheduler registration and bootstraps no cursor. It carries no model weights, so `bun run --cwd packages/model-runtime setup` is not a precondition for it, and the lookup is arithmetic over a local table — there is no request to make. The dataset's provenance and CC-BY attribution ride in the shipped bundle as `LICENSE-GEONAMES.md` and are restated in [`packages/model-runtime/LICENSES.md`](../packages/model-runtime/LICENSES.md); refreshing the snapshot means re-deriving the table and restating the licence version with it.

OCR accepts both image media types and `application/pdf`. For a PDF, the handler extracts each page's text layer when present. A page without usable embedded text is rendered locally and passed through the same bundled image recognizer. Capture invokes this same automation synchronously, so missing assets and model failures become ordinary automation-ledger failures rather than a separate gateway error vocabulary.

### Models arrive at first boot

Weights are release assets, so a fresh gateway has none. That is **preparing**, not off. After the first scheduler reconcile the gateway calls `ensureModelAssets` in the background ([`enrich/system-model-assets.ts`](../packages/server/src/enrich/system-model-assets.ts)) for exactly the capabilities the three system handlers' own model constants are pinned under — `faces` from `FACES_MODEL_ID`, `ocr` from `OCR_MODEL_ID`, both read from [`model-ids.ts`](../packages/model-runtime/src/model-ids.ts) rather than restated, and the capability list itself derived from `models.lock.json`. `doc-text-extractor` ships no bundled deterministic engine, so it carries no weights and is never preparing.

**Whether this host may fetch at all is the host's call, not the gateway's.** `BuildGatewayOptions.modelAssets.provision` is `"fetch"` or `"verify-only"`, and it **defaults to `"verify-only"`**: an unconfigured gateway — a test, an e2e harness, an embedded build someone forgot to configure — verifies what is on disk, reports anything missing as `preparing` with "model assets are not provisioned on this host", opens no connection and arms no retry (there is nothing on that box that would make the weights appear). The production hosts say `"fetch"` out loud: `centraid-gateway` ([`cli/cli.ts`](../packages/server/src/cli/cli.ts)) and the desktop's embedded gateway ([`embedded-gateway.ts`](../apps/desktop/src/main/embedded-gateway.ts)). The paragraph below describes a `"fetch"` host.

Boot never waits on a download. Until a capability's every pinned file is present and digest-verified, its automation reports `modelState: "preparing"` on the automations status surface, the component `recognition-models` reads degraded in Diagnostics with the reason, and the recipe's **scheduled** fire is skipped with that reason in the log — the registration and the cursors are untouched, so the tick after the assets land simply proceeds and the walk catches up on its own. A manual run is never skipped: the owner asking is the answer, and the handler's own "model assets unavailable" summary is the honest one. An unreachable upstream is reported and retried on a backoff (30 s, doubling to a 30-minute ceiling), never in a tight loop, and the weights land in the directory that automation's handler actually reads — the one `resolveAutomationRuntimeDir` resolves for the sandbox, `CENTRAID_AUTOMATION_RUNTIME_DIR` when set.

`set-enabled` is **refused** for a system automation (HTTP 409, `system_automation`). The bit is not the control: the release decided the recipe runs, so a write here would leave a manifest saying one thing while the scheduler does another until the next mount reverted it. Pause background work to stop it transiently, or set the domain's enrichment tier to `off` to stop recognition vault-wide.

### Regenerating

Two vault verbs, in [`packages/vault/src/commands/enrich.ts`](../packages/vault/src/commands/enrich.ts). Both drop derivation **stamps** and nothing else — the handler overwrites the derived value when it re-derives, and deleting the value early would blank a working search index for the length of a backlog walk.

| Verb | Input | What it does |
| --- | --- | --- |
| `enrich.regenerate` | `{ content_id \| asset_id, capability }` | Drops that target's stamp for the capability and enqueues a `manual` `enrich_request` for it, which the priority pass drains first. Either id names the same photograph: `faces` stamps the asset and `ocr` stamps the content item, so both halves are resolved and cleared. |
| `enrich.regenerate_all` | `{ capability }` | Drops every stamp for the capability and rewinds the owning recipe's ambient cursor state keys to `""` — the beginning of the library. It does **not** touch the recipe's model or selection key, which is what would otherwise re-seed the cursor past everything on the very next fire. |

**A model swap needs neither verb.** The stamp carries the model id (`enrich_derivation.model`), and every handler treats a stamp whose model differs from the one it ships as absent — so bumping an id in `model-ids.ts` re-derives the library behind the recipe's own bounded cursor, with no migration and no backfill command. The verbs are for the other case: doing one photograph, or the whole library, over again at the _same_ model.

## Model assets

The repository does not commit model weights or native ML packages. Run:

```sh
bun run --cwd packages/model-runtime setup
```

The setup command installs runtime dependencies—including PDF.js and its adjacent worker—into the non-workspace `packages/model-runtime/runtime/` directory and downloads pinned model files beneath `runtime/models/`. Generated handlers resolve assets from their local `runtime/` by default; `CENTRAID_AUTOMATION_RUNTIME_DIR` may point them at another local asset directory. This variable selects files only—nothing listens on a socket and no inference request crosses a process boundary.

Model versions, hashes, licences, and sources are recorded in [`packages/model-runtime/LICENSES.md`](../packages/model-runtime/LICENSES.md) and `models.lock.json`. A root `bun install` does not pull the optional native dependencies.

## Scheduling, consent, and provenance

The automation engine owns scheduling, policy gates, bounded fires, cursor state, retries, Test run, and the conversation ledger. There is no gateway-private capability sweep. A model or prompt revision changes the handler's selection key and re-arms only rows whose compatible derivation stamp is behind.

**Every system automation fires on ingest**, `faces` included (ruled 2026-09-09, [current decisions](decisions.md#recognition-automations-and-derived-data)). Recognition is what the photos pipeline _is_: it runs bundled models over the member's own bytes on their own gateway, costs nothing per fire, and leaves nothing but vault rows. It is turned **off** vault-wide by setting the domain's `enrich_policy` tier to `off`, and the member's own `enrich_policy` rules still decide every capability — but there is no per-recipe `enabled` toggle to find first, and no consent sheet before the first scan. The four bundled-optional recipes are the other half of that sentence: they ship off, and turning one on is the member's ask.

`faces` runs three passes inside one bounded batch, in this order: open `enrich_request(capability='faces')` rows (the search-miss / on-view / manual priority lane, drained first and marked `drained_at`), then content carrying a prior faces stamp whose model is behind, then an ambient walk of the library behind its own `asset_id` cursor. They share one budget of 16, so a busy request queue simply leaves the ambient walk nothing to do this fire and the owner's explicit ask is never queued behind the backlog. Detection and recognition use YuNet + ArcFace, and regions land as proposed review items — naming a face is still the member's act. [`media.forget_person`](../packages/vault/src/commands/media.ts) removes face regions, embeddings, derivation stamps, and clusters associated with the party.

`doc-text-extractor` is a **system** automation: making a scanned or binary document searchable is part of what the documents pipeline is, so it is armed like the other two. Its billed half is still gated where billing is gated — it declares `lane: "gateway"`, so a model turn runs only within the vault's tier and the egress-consent ledger. On a vault that has answered nothing, it runs its on-device work and its delegate step stays sealed.

## Delegate variants and engine profiles

Two enrichers ship a delegate variant: `photo-ocr` (`ocr`) and `doc-text-extractor` (`doc-text`). A delegate variant uses `ctx.delegate` through the existing ACP/provider-egress consent rail, canonicalizes the response into the same typed command the deterministic path writes, preserves absent confidence, and stamps only ACP-confirmed model identity — never the model id that was asked for. That explicit delegation path is not a generic inference primitive, and no other capability has one. `faces` never will: face recognition is biometric identification and admits no delegate profile at all (`enrich/engine-profiles.ts`).

**Which variant runs is a policy answer, not a manifest field.** `manifest.enrich.delegateStep` DECLARES that a delegate variant exists — the prompt revision the handler ships, the honest latency, the consequence of switching. The choice is the engine profile the policy cascade resolves for the capability (`enrich/engine-profiles.ts`, `automation/fire/enrich-resolve.ts`): a profile bound to a harness selects the delegate variant and carries its model, config pins and prompt revision into the fire and onto the dispatch surface. The manifest's own `selected: "delegate"` remains honoured as the pre-existing per-recipe switch, and a vault with no rules and no profiles fires exactly what it fired before.

Consequences of that seam, each enforced on the fire path:

- A delegate variant with no pinned model anywhere is refused before any dispatch surface opens. Consent is decided once, upstream, at the one enrichment gate; engine details are read only after it allowed the run.
- A delegate profile selected for a capability whose handler has **no** delegate code path — the embedding capabilities today — is inert: the deterministic engine runs, the input is untouched, nothing reaches a provider, and the selection is logged. Settings → Enrichment says so on the profile itself, from `CapabilityContract.delegateCapable` carried on every profile the profiles route lists — inertness is stated where the choice is offered, not left to the run log. A future engine can be selected for `embed-*` without a policy change; this build simply ships no delegate implementation for them.
- A profile may pin a prompt revision, but the prompt text belongs to the handler: a handler refuses a revision it does not ship rather than stamping one it did not send.
- Derivation stamps carry the profile that produced them (`enrich_derivation.profile`, defaulting to `built-in`), and handlers read and re-derive per profile. Two profiles' answers for one target are two rows, never a re-derivation loop.

`doc-text` has no bundled deterministic engine — extracting text from a scan is a model turn either way, which is why it declares `lane: "gateway"`; the tier and the consent ledger, not an `enabled` flag, are what decide whether that turn happens. Its variants are therefore "the engine this vault runs automations on" versus "the engine the member bound `doc-text` to", the latter pinned, prompt-revisioned and stamped.

## Testing and live-model evidence

PR tests inject model functions into the bundled handler sources and exercise pure tokenizer, CTC, geometry, postprocessing, cursor, consent, and typed-command behavior without installing native dependencies or weights. The weekly/release live lane uses pinned real weights and committed fixtures:

```sh
bun run --cwd packages/model-runtime setup
bun run test:enrich:live
```

The live suite checks OCR image and PDF behavior, embedding cosine tolerances, face count/geometry, model/version pins, and licence integrity. Model-quality judgements such as OCR recall, cluster purity, and search relevance remain dogfood evidence rather than deterministic CI gates.

## Related

- [`ARCHITECTURE.md`](../ARCHITECTURE.md) — runtime placement and automation lifecycle.
- [`docs/photos/derived-ledger.md`](photos/derived-ledger.md) — vault provenance, semantic search, faces, and backfill.
- [`docs/blueprint-seats.md`](blueprint-seats.md) — the app/automation model-access doctrine.
- [`packages/model-runtime/README.md`](../packages/model-runtime/README.md) — build and asset setup commands.
