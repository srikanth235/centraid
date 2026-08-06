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

## Enrichment doctrine

Settled **2026-08-06** (issue #712 C5). Two roads reach the model, and an enricher never invents a third:

1. **`ctx.agent`** through the ACP runner registry (`packages/app-engine`) — a coding-agent harness turn, dispatcher-gated per call for provider egress (#567).
2. **The device work-lease lane** (`enrich_request.required_capability` + `packages/vault/src/enrich/leases.ts`) — iOS Vision / Android ML Kit / a local Tesseract-compatible worker, bytes never leaving the member's own devices.

No blueprint app or automation imports a provider SDK to make a third road (`packages/blueprints/src/no-inference-client.test.ts` is the conformance check).

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
