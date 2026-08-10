# Blueprint seats

Settled **2026-08-05** (Photos v4 design session). How the three client surfaces differ for blueprint apps, which machinery each app class needs, and the north-star product each app mimics. Cite this file instead of re-deriving the split per app; if a decision is wrong in practice, change it here in the same PR that diverges.

**Why north stars at all:** each blueprint deliberately mimics the most popular incumbent in its category so a member switching to Centraid meets no new mental model. Friction is the enemy; novelty is not a goal. When a design question has no answer in the handoff, the north star's behaviour is the default answer.

## The three seats

Form factor (`compact`) says how wide the window is. The **seat** says where bytes live and which way they flow. They are orthogonal: a PWA on a phone is compact but still a viewer; a narrow desktop window is compact but still the custodian's console. Never branch custody logic on `compact`, and never branch layout on seat.

|  | **Mobile (Expo)** | **Desktop (Electron)** | **Web / PWA** |
| --- | --- | --- | --- |
| Seat | **origin** — content is born here (camera, scanner, mic) and cached here | **custodian** — the gateway is a local child process; bytes are effectively local | **viewer** — a replica of meaning; bytes arrive only on request |
| Default byte flow | up (device → gateway) | none — it is the destination | down (gateway → browser, on demand) |
| Danger state | `local-only` — content one accident from gone | gateway disk / backup health | staleness — replica behind the vault |
| Offline means | camera roll + cache fully work; sync resumes later | nearly cannot happen (local gateway) | meaning renders, bytes do not |
| "Free up space" | core feature (evict `backed-up` originals) | rarely meaningful | meaningless |

Code constant: each bundle declares `SEAT: "origin" | "custodian" | "viewer"` as a build-time fact — never a user-agent sniff. See [platform-gating.md](platform-gating.md) for the signal table it joins.

## Two classes of blueprint

| Class | Apps | What the seats must do |
| --- | --- | --- |
| **record-only** | tasks, agenda, people, tally | Payloads are rows. The replica gives every seat full offline for free. No custody states, no upload queue, no download gate. |
| **byte-bearing** | photos, docs; notes and locker via attachments | Needs the custody triple, the backup engine (up), the pin/download engine (down), free-up-space, and the metered gate. |

Every hard per-seat question in the Photos v4 audit was a byte-bearing problem. An agent building a record-only app should not touch any of that machinery.

## Byte custody vocabulary

One triple, system-wide (already shipped in `apps/mobile/src/apps/photos/timeline-model.ts`):

| State | Meaning | Tile slot 4 |
| --- | --- | --- |
| `local-only` | on this device, **not** on the gateway | the custody **mark** — a cloud-slash glyph, from rung S |
| `backed-up` | on the device and the gateway | — (nothing to explain) |
| `remote-only` | gateway only; offloaded from this device | — , except when the gateway is **unreachable**, where the line `on the gateway` explains a tile that cannot paint |

**The triple is a data model; the tile is a binary.** The rule is about ALTITUDE, and it is the part that keeps getting re-litigated, so it is written down rather than left to taste:

- **Per-tile** — the exception only, as a **mark, never a sentence**. `local-only` is the one custody state a member can lose something to, so it is the one that earns a glyph. The two normal states say nothing.
- **Per-shelf** — the population fact, as a count (Backup health's "N on this device only"). This is where an anxious member actually looks, and where the mark is taught.
- **Per-photograph** — the full story, on demand, in the viewer's info sheet.

Slot 4 resolves to **at most one** of a line or a mark (`stateOverlay` returns one value with two shapes, so the exclusion is structural, not a convention). Precedence: `could not decode` → Trash's countdown → `on the gateway` when unreachable → the custody mark. Every case that produces a line is one where custody is not the actionable fact.

Why not a line per tile: it labelled the steady state (`remote-only` is where bytes are _designed_ to live) and the default (in a fresh camera roll every photograph is `local-only`), in prose, under every tile — chrome inside the grid, which §18 forbids. Both Apple Photos and Google Photos independently arrived at the same answer: annotate the exception, never the norm, and never with words. Web already worked this way (`packages/blueprints/apps/photos/media.ts` draws its note only when there are no bytes to paint), so the phone was the surface that had drifted.

Web's `TileMediaState` (`pending | bytes | gateway | failed`) is the **paint pipeline**, not a competing custody model — a viewer seat is never an origin, so `local-only` cannot occur there.

## North stars

| Blueprint | North star | Settled consequences |
| --- | --- | --- |
| **Photos** | Google Photos | Merged mobile timeline (camera roll + vault as one stream, `local-only` marked per tile). Backup is **automatic-with-policy**: one consent moment, then Wi-Fi/charging/roaming policy — never per-photo. Per-item "back up now" survives only as a manual override. |
| **Docs** | Google Drive | Fully feature-rich: folders, sharing, versions. Viewer downloads on demand; mobile gets offline **pins** and the scanner as an origin act; desktop gets bulk import / drag-out. |
| **Notes** | Apple Notes | Folder hierarchy (not labels). Offline-first editing on every seat with background merge; mobile origin acts: quick capture, voice. |
| **Agenda** | Google Calendar | Full replica on all seats; offline read + queued writes; notifications are a mobile-seat act. |
| **Tasks** | Todoist / Apple Reminders | Same shape as Agenda: tiny payloads, all seats equal, write queue. |
| **People** | Google Contacts | Full replica; mobile wants OS-contacts import and share-sheet in/out. |
| **Locker** | 1Password | Biometric unlock + OS autofill on mobile. **Disabled on the PWA seat for now** — a shared browser is the risky seat; revisit post-v0 with a re-auth-per-open design. |
| **Tally** | Splitwise | Shared expense splitting: multi-party balances ("who owes whom"), naturally at home in a shared/household vault. Record-only; mobile origin act: receipt photo (byte-bearing only at that edge). |

## Shared engines (build once, per-app never)

1. **One backup engine, one policy.** The upload queue (`apps/mobile/src/apps/photos/photos-backup.ts`) and the Wi-Fi/charging/roaming policy become **frame-owned**. Google's model: one backup setting per account, not per app. Docs' scans and Notes' attachments enqueue into the same engine; consent is asked once.
2. **One pin/download engine** for viewer seats — Photos' metered gate (`MediaPage`) generalised so Docs' "available offline" is the same machinery as Photos' "load the original".
3. **The reachability contract.** Web: the shell stamps `data-gateway-status` on every inline app root (`InlineAppRoute`); blueprints read it (`libraryReachability`). Mobile: `kit/hooks/replica-query-state.ts`. The §14 offline banner grammar (bordered `--net`, no fill, no icon, outlined Retry) is the one way to say offline.
4. **Origin acts live on the frame; apps register targets.** `Capture.tsx` and `Scan.tsx` already point this way. Camera, scanner, share-sheet-in, notifications, autofill are frame capabilities an app declares — one door for every app.
5. **The refusal grammar** — outcomes to the one status line; disabled controls visible, inert at the handler, and explained inline (never a tooltip).
6. **One search scaffold, per-app entity config.** `packages/blueprints/apps/_shared/search-scaffold.ts` (pure: status union, `groupSearchHits` over a per-app `SearchEntity[]` config, `SearchStateCopy`) + `SearchScaffold.tsx` (the ruled-row / four-state rendering) — issue #712 S1. Photos' `SearchShelf.tsx` and Tally's `components/Search.tsx` both render through it; mobile's `search-hits.ts` consumes the pure `groupSearchHits` combinator directly (no UI change). Matching stays app-owned — only "find, then cap, then order" is shared, per this doc's own worked example above: the words differ by seat, and now the states and grouping mechanics do not have to be reinvented per app to say them.
7. **One selection engine, app-owned nouns.** `packages/blueprints/apps/_shared/selection-engine.ts` owns immutable select/toggle/range/prune transitions, the fixed action-slot contract, disabled-handler honesty, and serial failure-isolated batch execution. Web and native import it. Each app keeps the action names, vault commands, optimistic rows, copy, and receipts that make those transitions mean something in its domain; Docs bulk-move or Notes bulk-delete must join the engine rather than fork Photos' mechanics.

## Engine contracts

Settled **2026-08-06** (issue #712 E2). The list above says WHAT is built once; this says what each engine promises, so an agent can consume one without reading its implementation. Every contract names three things: its **verbs** (the only way in), its **reason-string grammar** (what the surface must be able to say when it refuses), and its **structural exclusions** — the cases made unrepresentable rather than filtered at render time, because a rule enforced by a type or an absent registry row cannot be forgotten the way a rule enforced by an `if` can.

One canonical gate per engine is registered in `tests/matrix.json#appEngines` and validated by `bun run test:matrix`. The existing source-shape gates remain in `scripts/lint-engine-conformance.mjs` (wired into `check:push` as `lint:engine-conformance`), with the single-package halves left beside their contracts: `packages/blueprints/src/placement-registry.test.ts`, `blueprint-seats.test.ts`, the `_shared` engine tests, and `packages/blueprints/src/no-inference-client.test.ts` (the provider-SDK and second-enrichment-client ban, scanning browser, native, and automation trees).

**A — sharing.** `packages/blueprints/apps/_shared/placement-registry.ts` is the structural answer to “which container can cross vaults”; `packages/vault/src/share/actable.ts` is its write-command sibling. The ShareSheet has one verb: `window.centraid.share({ sourceVaultId, containerType, containerId, members })`, creating an implicit per-container circle unless the member deliberately picked a named circle. Each member gets `read` or `read+write`; an undeclared container or command refuses at the gateway/steward, never by render filtering. Give remains only as the receiver's “Save to my vault” action over the existing projection primitive. Reason grammar: a refusal's gateway reason is printed verbatim. Structural exclusion remains **Locker × sharing**: `locker.item` is absent from `PlaceableItemType`, so a Locker sharing control is a type error.

**B — custody.** `apps/mobile/src/kit/transfer/` (up) and `apps/mobile/src/kit/storage/` (down and out) are the frame's only doors to moving and releasing bytes. Verbs: `answerBackupConsent` / `automaticTransferAllowed` (the one consent moment), `writeTransferPolicy` + `TRANSFER_POLICY_SWITCHES` (the Wi-Fi/charging/roaming record), `readTransferQueue` + `backupVerdict` (what this device is still carrying), `readCustodyStatus` / `foldCustodyStatus` (where the originals are), `freeUpOffer` + `revalidateBackedUp` (releasing them, re-hashed at delete time). Reason grammar: every inert switch carries `inertReason(policy)` — required on the switch's own shape, so a sixth rule cannot arrive without a sentence — and every unreadable source states which source failed rather than folding to zero ("could not be read", "not yet computed"). Structural exclusions: **record-only × custody** (`blueprint-seats.test.ts` for the web tree, the custody check for the mobile one) and **Locker × free-up-space** — a secret has no device original to evict, so it is not in `FREE_UP_APPS` at all.

**C — consent.** `packages/blueprints/apps/_shared/consent-gate.ts` is the shape; `ConsentGate.tsx` in that directory (web) and `apps/mobile/src/kit/components/ConsentGate.tsx` (native) are its two renderers. Verbs: `onRunOnDevice`, `onDecline`, `onChooseNet` — three callbacks and no internal state, so "can a write be issued without an explicit answer" is a question about a caller's props. The tier gate is one rank comparison, `decideEnrichmentGate` in `packages/automation/src/fire/enrich-gate.ts`. Reason grammar: `AnswerAvailability` is `{ available, reason? }`, and an unavailable answer renders its reason **beside the control**, never as a tooltip and never as silence; the `--net` panel renders even when its action cannot be taken, because a member who cannot choose egress still has to be told what it would cost. Structural exclusion: **Locker × enrichment**. `domain` is typed `EnrichDomain` (`photos | docs`), so Locker has no value to supply — there is no secret-scanning consent moment to build.

**D — triage.** One verb answers a proposal: `media.answer_face_proposal` (`packages/vault/src/commands/enrich.ts`), with three answers — confirm, reject, dismiss — writing `media_face_region.review_state`. The `media.confirm_face` / `media.reject_face` pair it replaced is **retired, not deprecated beside it**: reject was a DELETE, which is not a state, so the enricher was free to re-propose the same stranger for ever and a review queue could never be finished. The generic session state machine is `packages/blueprints/apps/_shared/triage-session.ts` (`openTriage`, `triageCurrent`, `triageSkip`, `triageAnswer`, `triageRefill`, `triageProgress`), pure and imported verbatim by browser and native seats; its frozen denominator is why the numerator counts up instead of the total sliding around mid-session. Reason grammar: skip records nothing and says so; a queue control that goes inert must say why, since a member stuck at "1 of 54" with a grey control has no next move. Structural exclusion: the outcome vocabulary is per app — the shared module knows neither faces nor duplicate clusters — so a third consumer joins by naming its outcomes, not by widening the engine.

**E — search.** The search scaffold is row 6 above (`apps/_shared/search-scaffold.ts` + `SearchScaffold.tsx`). It has no write verb: its law is a pure configured grouping/cap/order combinator plus a four-state renderer, while matching stays app-owned. Structural exclusion means an app does not consume the scaffold at all; it is never represented by a renderer that silently searches nothing.

**F — enrichment boundary.** Apps enqueue consent-scoped `enrich_request` rows and read model-versioned vault projections. Recognition templates orchestrate the work through deterministic `ctx.fetch` (or OCR's optional `ctx.agent` variant); only the gateway's reserved executor imports `packages/gateway/src/enrich/service-client.ts`. Blueprint/native/template code imports neither that client/service nor a provider SDK. Reason grammar is the automation outcome: unconfigured service, missing capability, policy skip, or model failure remains capability-scoped and ledger-visible rather than being relabelled success. Structural exclusion is the closed `EnrichDomain` union and the app's absent consent/control surface.

**G — scope kit + commons.** `packages/blueprints/apps/_shared/scope-kit.ts` is how an app reads independently resident vault rows without writing sharing transport. A `ScopeAppDeclaration` still names only `mergeKey`, `mintedIdFamilies`, and the string-tagged `projectionIngest` door. Commons adds no app-local sync engine: the compiler projects domain closure + blobs into each member vault, each seat's ordinary replica cursor observes that vault, and `mergeScopePages` reads it like any other scope. Logical `(grant, member vault)` operation offsets belong to vault core, not to the blueprint. Tasks remains the record-only proof; Photos remains the byte-bearing proof. Tally is the multi-writer proof: every `read+write` group member submits commands to the one steward sequence, then every seat computes balances locally from identical expense/split rows — no balance projection crosses the commons.

## One computation

A product-law computation lives exactly once: **in the vault as a model-versioned projection when it is derivable server-side, otherwise in `packages/blueprints/apps/_shared` as a pure module imported by every seat**. Browser and native components are adapters over that result; they do not maintain seat-local versions of the arithmetic.

Pure app-delta arithmetic follows the [scenario × layer template](plans/app-scenario-layer-template.md): put a `*-model.ts` beside the view and exercise it at the U layer. When the same concept spans seats, promote the pure law to `_shared` instead of copying the model. Photos' face crop, confirmed-photograph people counts, triage session, and selection transitions are the reference hoists; its Memories rail reads the gateway-built `media.memory` / `media.memory_member` projection rather than deriving another rail client-side.

`packages/blueprints/src/one-computation.test.ts` is the mechanical guard. It fails on any new runtime export-name collision between the Photos blueprint and native app directories and explicitly asserts that shared crop/count modules are imported by both seats. The legacy collision list is tighten-only: a new collision fails, and removing an old collision must shrink the baseline in the same change.

## Enrichment doctrine

Settled **2026-08-06** (issue #712 C5), amended **2026-08-08** by #725 for the #724 reference service. Product code reaches model work only through host-owned seams:

1. **`ctx.agent`** through the ACP runner registry (`packages/app-engine`) — a coding-agent harness turn, dispatcher-gated per call for provider egress (#567).
2. **The device work-lease lane** (`enrich_request.required_capability` + `packages/vault/src/enrich/leases.ts`) — non-model device work such as poster and PDF-text extraction, bytes never leaving the member's own devices.
3. **Deterministic recognition automations** — bundled handlers call the optional `CENTRAID_ENRICH_URL` executor only through governed `ctx.fetch`; the automation engine owns schedule, policy, cursor, ledger, and retry, while the service only executes a model batch.

No blueprint app, native seat, or automation imports a provider SDK or the enrichment service client directly (`packages/blueprints/src/no-inference-client.test.ts` is the conformance check). Apps express intent as rows and consume vault projections; deterministic templates use the host-owned reserved fetch, while OCR's agent variant uses the existing ACP and egress-consent rails.

**The trust-domain boundary.** A member's trust domain is their own devices _and_ their own gateway — the gateway is not, by itself, egress. What IS egress is a runner that talks to a **third-party provider**; every runner shipped today happens to be one, which is a fact about the roster, not a definition. The door stays open for a gateway-hosted local-inference runner (a custom `acp` kind fronting a model with no network egress) whose model turns would be legitimately inside the trust domain — the deciding fact is "does this runner egress to a provider", a property of the runner, never of which machine issued the call.

**One axis, three points.** `off | device | gateway` (`packages/automation/src/fire/enrich-gate.ts`), ordered by how far work may run — `off` (nothing), `device` (the member's phone/laptop, plus deterministic gateway work), `gateway` (the member's own gateway may additionally do whatever it is already wired to). There is no fourth `provider` tier: provider egress is enforced per call at the dispatcher (#567) and per capability at the consent gate (decision S9), independently of this tier. An enricher declares the **lane** it needs (`manifest.enrich.lane: "device" | "gateway"`); the gate is one rank comparison, `rank(lane) <= rank(tier)`. Every enrich domain (`ENRICH_DOMAINS`: `photos`, `docs`) declares its enrichers' lanes the same way — none of them invent their own transport.

## Worked example: search is not one behaviour

Photos search resolves differently per seat, and the copy has to follow:

| Seat | How it resolves | What the surface says | Offline |
| --- | --- | --- | --- |
| viewer (web/PWA) | live gateway FTS5 (`ctx.vault.search`), no replica in the path | `N results · searched the live library` | cannot search — the `--net` unreachable panel is the honest answer |
| origin (mobile) | the on-device replica's eager metadata | `N results · searched the whole replica on this device` | searches fine; may be behind the vault |

Neither is a deviation from the handoff — the handoff was written for one seat. The rule "a surface never teaches a different fact about the same control" governs **facts**, not strings: where the underlying truth differs by seat, the words must differ with it, and where it does not, the words are shared verbatim. Web additionally matches free-form tags (`core.tag_item`), which the mobile replica does not carry, so `things` appears in one client's copy and not the other's for the same reason.

## Per-app seat profile (machine-readable)

Each blueprint's `app.json` grows a `seats` block so coding agents get the split without reading this prose:

```json
"seats": {
  "byteBearing": true,
  "originActs": ["camera"],
  "disabledOn": [],
  "northStar": "google-photos"
}
```

Locker declares `"disabledOn": ["viewer"]`. Record-only apps declare `"byteBearing": false` and should fail review if they import custody machinery.

## Open follow-ups

- ~~Wire `SEAT` and the `seats` manifest block~~ — done: `apps/mobile/src/lib/seat.ts`, `seat()` in `packages/client/src/react/host-platform.ts`, all eight `app.json` blocks validated by `packages/app-engine/src/registry/manifest.ts`, tripwire in `packages/blueprints/src/blueprint-seats.test.ts`.
- ~~Move backup policy from Photos-owned screens to the frame.~~ Done: the record, the consent latch, the serial run and the queue readout are `apps/mobile/src/kit/transfer/`. `lib/upload/native-policy.ts` still evaluates the record against the radios; the switches still _render_ on Photos' Backup screen and should move to frame Settings next.
- ~~Photos: retire per-photo "hold to back up" as primary; add the `local-only` tile line.~~ Done: automatic sweep on consent, per-item backup demoted to the manual override, `on this device only` in the tile's state slot.
- The automatic sweep only enqueues while a Photos surface is mounted (the camera-roll walk is the timeline engine's). Between launches the durable queue still drains headlessly; newly-taken photographs are enqueued the next time Photos is opened. A frame-level camera-roll watcher would close that gap.
- ~~Locker: enforce the PWA disable at the shell~~ — done at the mount path (`inlineAppSeats.ts` + refusal block in `InlineAppRoute`), driven by the manifest. Tile-level treatment (greying the springboard/All-apps entry) deliberately deferred until the post-v0 re-auth design is settled.
