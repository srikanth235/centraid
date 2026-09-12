# Recognition placement — the third execution site

**Status: a proposal, not a build.** Nothing in this document is implemented.
It is written for the root to integrate across the automations lane, because
every item below moves a shared plane and none of them can move alone.

Scope: [#1020](https://github.com/srikanth235/centraid/issues/1020) **open
question 9** — *faces and OCR on the device that holds the asset (Vision, ML
Kit) with a gateway CPU fallback; text and image embeddings on the gateway
through `ort` under a rate budget; weights fetched on first use, never bundled.*

Current state this proposal starts from, all of it citable:
`docs/recognition-automations.md`, wave 4 census §C4/§C5, and
`packages/server/src/automation/fire/enrich-gate.ts`.

---

## 0. What already exists, and what the half-built name hides

Half of open question 9 is **already in v0 and needs porting, not designing**:

- **Weights fetched on first use, never bundled.**
  `packages/model-runtime/models.lock.json` pins every file by sha256, byte
  length and an immutable upstream URL, and `ensureModelAssets` verifies what
  is on disk and fetches only what is missing, into a temp file renamed only
  after the digest matches. A capability whose upstream is unreachable is
  **reported, never thrown**, and its automation stays unavailable until the
  next boot. **This half is built in this lane** as
  `crates/media::models` (`Lock::parse`, `verify`, `ensure`, `Fetch`), with the
  network fetcher left as the host's.
- **`ort` for embeddings on the gateway** is a substitution inside step 3 of the
  one handler boundary (`docs/recognition-automations.md:57`–`:63`) and changes
  nothing structural.

What does **not** exist is any device-side execution at all — and the name is
already taken. Today `tier = "device"` means *the gateway's deterministic
engine with `ctx.delegate` sealed* (`enrich-gate.ts:67`–`:69`,
`sealModelTurns`), not "runs on the phone". So:

> **The v1 `device` lane is new behaviour wearing an existing name.** A member
> who set "device" in 2026 chose "no model turns leave my gateway". A build that
> re-reads that stored value as "run models on my phone" has changed what they
> consented to without asking.

That is the single fact every item below is shaped by.

---

## 1. The tier vocabulary

**Options.**

- **(a) Re-mean `device`.** `tier = "device"` starts meaning "on the device that
  holds the asset, else the gateway". One word, no migration.
- **(b) A fourth value.** `tier ∈ off | on-device | sealed-gateway | gateway`,
  with `device` read forward as `sealed-gateway`.
- **(c) Split the axis.** Keep `tier ∈ off | device | gateway` as *how much
  model* and add an orthogonal `site ∈ gateway | holder` as *where*.

**Recommendation: (b).** (a) silently re-means a stored consent, which is the
one thing the trust premise forbids. (c) is the cleanest model and the worst
migration: two columns whose four legal combinations include one nobody wants
(`off` × `holder`), and every gate in the fire path has to learn a second
comparison. (b) keeps the gate as `rank(lane) ≤ rank(tier)` with one more rung,
and the read-forward shim is the pattern `enrich_policy`'s CHECK already carries
for `local`/`model` (the port reads those forward and never writes them back —
`crates/apps/photos/src/enrichment.rs`).

**Ranking, and the one thing that is not a rank.** `off(0) < on-device(1) <
sealed-gateway(2) < gateway(3)`. `on-device` is **below** `sealed-gateway`
because it is the narrowest egress, not because it is the least capable — and
the fire gate reads a stored answer *only to refuse, never to permit*
(`enrich.ts`'s `recordEnrichConsent` note), so a member on `on-device` never
silently acquires the gateway lane.

**The trap to keep:** an omitted lane reads as `gateway`
(`enrich-gate.ts:1`–`:39`) — **assuming cheaper assumes consent**. A fourth
value must not tempt anyone to make the default cheaper.

---

## 2. The `enrich_derivation` stamp: *where* a model ran

Today the stamp carries the capability, the model and the version, and "a model
id change is a model bump, not a migration" (`:91`) — a vault holding
`yunet-sface@1` rows re-derives behind the cursor.

**Options.**

- **(a) Fold the site into the model id** (`yunet@1/ios-vision`).
- **(b) A `site` column** on `enrich_derivation`, `NOT NULL DEFAULT 'gateway'`.
- **(c) A `site` column plus a `device_id`** naming which device ran it.

**Recommendation: (c), with the `device_id` nullable and `ON DELETE SET NULL`.**
(a) makes two facts one string and turns "the same model ran in two places" into
a re-derivation of the whole library. (b) cannot answer the question a member
will actually ask — *which of my phones read my photographs* — and cannot answer
the operator's either: if one device's Vision build produces bad boxes, (b)
gives no way to select the rows to re-derive. The `SET NULL` is the same rule
`core_entity_revision.actor_party_id` carries: losing the device must not delete
the evidence that the work was done.

**What must NOT be in the stamp:** the model's own output. A stamp is provenance.

---

## 3. `enrich_target_failure`: a device that is offline is **parked, not failed**

Today: `enrich.record_target_failure` counts against `(capability, target)`;
under the cap the walk **parks**, at the cap the target is **declined** and the
cursor advances past it. Two caps because two different waits —
`ENRICH_TARGET_MAX_FAILURES` 3 and `NOT_READY_MAX_TICKS` 12 — and stamping a
derivation clears the record.

A device that holds an asset and is switched off is **neither** of those. It is
not a permanent failure (the photograph is fine), and it is not a "not ready
yet" that twelve ticks will resolve (a phone in a drawer for a month is still
in the drawer).

**Options.**

- **(a) Count it as `not-ready`.** Twelve ticks, then declined.
- **(b) A third class, `awaiting-holder`, with NO cap** and no count.
- **(c) A third class with a long cap** (say 90 days), then fall back to the
  gateway lane if the tier allows it.

**Recommendation: (b) for the count, (c) for the cursor.** Concretely:

- an unreachable holder writes **no row** in `enrich_target_failure` — the
  target is parked by the *absence* of a lease, not by a failure count, and
  "counting" it would decline a member's photographs for being on a phone they
  did not bring;
- the **cursor still advances** past a parked target, because a cursor that
  waits on one device stops recognition for the whole library — and a parked
  target is re-examined by a second, cheap selection over "assets with no
  derivation whose holder is now online", which is what `enrich_request`'s
  existing `required_capability` + `lease_expires_at` index is already shaped
  for;
- a **fallback after a stated wait** (the tier's own `gateway` rung, when the
  member is on `gateway`) is offered as a *setting*, not a default. A silent
  fallback is the "assuming cheaper assumes consent" trap in reverse.

**The gate this needs:** a test that a parked target writes nothing. Otherwise
the first incident report is "my library stopped being recognised" and the
`enrich_target_failure` table is where the answer is hiding.

---

## 4. The cursor's meaning, per site

Today one cursor per `(automation, capability)` walks the library behind the
recipe. With two sites there are two walks at different speeds over one
library.

**Options.**

- **(a) One cursor.** The slower site holds the faster one back.
- **(b) One cursor per site.** Two cursors over one library.
- **(c) One cursor plus a parked set.** The cursor is the *frontier*; parked
  targets are a separate, smaller selection re-examined out of band.

**Recommendation: (c).** (a) makes a phone in a drawer stop the gateway's OCR.
(b) is two answers to "how far has recognition got", which is the question a
member's progress line asks — and the two will disagree at exactly the moment
somebody looks. (c) keeps one frontier (so the progress line has one number) and
makes the parked set what §3 already needs it to be. The parked selection is
bounded by a stated window like every other read in the product.

---

## 5. What `crates/core` exposes to the shell, and what the shell must implement

**The shell is the only thing on a phone that can call Vision or ML Kit.** So the
core cannot "run a model"; it can only *ask*, and the shell answers.

**What `crates/core` exposes:**

- an **`EnrichAsk` event** on the existing `centraid.core.v1` stream:
  `{ ask_id, capability, target_type, target_id, content_ref, lease_expires_at }`
  — `content_ref` is a **door reference**, never bytes: on desktop the
  `centraid://` media door (wave 3 lane F), on mobile a materialised
  private-container path. The ask carries a **lease** so a shell that crashes
  does not hold a target forever;
- a command **`enrich.submit_derivation`** `{ ask_id, model, model_version,
  site, device_id, payload }`, whose payload is validated against the
  capability's own schema and whose handler is the SAME one the gateway's
  handler calls — so there is exactly one writer per capability and the device
  path cannot write a shape the gateway path could not;
- **no `ctx.infer`, no `ctx.enrich`, and no model client.** The rule
  `docs/recognition-automations.md:57`–`:63` states — *apps do not call
  models* — is unchanged: an app sees the policy mirror and writes a priority
  hint, and that is all (`crates/apps/photos/src/enrichment.rs`).

**What the shell's `expect` service must implement**, per platform, as an owner
hand-off with the command and the evidence:

| Platform | Engine | Evidence needed |
|---|---|---|
| iOS / macOS | `VNDetectFaceRectanglesRequest`, `VNRecognizeTextRequest` | a device run producing boxes within a stated IoU of the gateway's YuNet on a fixed frame set |
| Android | ML Kit face detection, text recognition | the same |
| Desktop (no Vision) | falls through to the gateway lane | that the fall-through is a *setting* and not a default |

**The embedding lane does NOT move.** Face embeddings are compared only within
one `enrich_embedding.model` (`:91`), so a device that produced 128-d vectors
and a gateway that produced 512-d ones never meet — which is a correctness
property today and becomes a *hard requirement* the moment two sites exist. So:
**detection and OCR may run on the device; embedding stays on the gateway**,
with one model, until there is a way to pin a device to the gateway's exact
embedding build.

---

## 6. The `ort` gateway fallback under a rate budget

**Options for the budget.**

- **(a) A concurrency cap** (N inferences in flight).
- **(b) A rate cap** (N inferences per interval).
- **(c) A cap on the *share* of a CPU budget**, measured.

**Recommendation: (a), stated per capability, with (b) as the ceiling on
retries.** A VPS with two cores and a member typing in Notes needs a bound on
*how much of the machine* recognition may hold at once, which is concurrency;
a rate cap lets N bursts land together. (c) is the honest model and needs a
measurement plane that does not exist.

**The weights half is built.** `crates/media::models` is the port of
`models.lock.json` + `ensureModelAssets`:

- `Lock::parse` refuses a schema version this build does not read, a digest
  that is not 64 hex characters, and **a path that escapes the models
  directory** — the last one is new: `path` is joined onto a host directory and
  then written to, and v0 does not check it;
- `verify` reports from disk and **opens no connection**, so an unconfigured
  host can never reach the network by accident;
- `ensure` fetches only what is missing, checks the length then the digest, and
  renames only over verified bytes;
- **a failure is reported, never thrown** — `ensure` returns `Ok` even when
  every capability failed.

Sizes, so the budget conversation has numbers: ArcFace 249 MB, CLIP ViT-B/32
606 MB, Whisper tiny.en q8 41 MB, PP-OCRv5 21 MB, YuNet 0.2 MB.

**The network fetcher is an owner hand-off.** `models::Fetch` is the seam and
`DirectoryFetch` drives every line of `ensure` except the socket; the HTTP
implementation belongs to the host that has one. Evidence it needs: one run
against the real upstreams reporting `ready` for `faces`, and one run against a
deliberately corrupted local file reporting the sha mismatch and leaving no
`.partial` behind.

---

## 7. Why this is root-integrated and not one lane's

Every item above moves a plane no single lane owns:

| Item | Plane | Owner today |
|---|---|---|
| the tier vocabulary | `enrich_policy`'s CHECK + the fire gate | automations |
| the derivation stamp | `enrich_derivation` DDL | root (a migration per wave slot) |
| `enrich_target_failure` semantics | the fire spine | automations |
| the cursor and the parked set | `automation_trigger_cursor` | automations (store) / assist (band) |
| `EnrichAsk` + `enrich.submit_derivation` | `centraid.core.v1` + `crates/vault/src/commands/enrich.rs` | core / root |
| the shell's `expect` service | `mobile/`, `desktop/` | the mobile and desktop lanes |
| the `ort` budget and the weights | `crates/media::models` + the gateway | built here / the host |

The wave 4 census reaches the same conclusion from the other direction
(§C5): *"that is a model change, not an app change, and it should be
root-integrated rather than owned by one lane."*

**One sentence, if only one survives:** the `device` tier already means
something, and the third execution site has to be a new word with its own rung,
its own stamp, and a parked-not-failed class — or the first thing v1 ships is a
consent nobody gave.
