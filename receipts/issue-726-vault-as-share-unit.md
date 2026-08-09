# Receipt — issue #726: the vault becomes the unit of sharing

<!-- governance: allow-receipt-per-issue PR #729 predates the current whole-change file crosswalk; exhaustively enumerating its 467-file historical branch would obscure the phase-by-phase behavioral evidence recorded below. -->

This receipt covers the #726 implementation across all seven phases (P0 ownership,
P1 a vault per person, P2 the closure split and the edge, P3 links and remote give,
P4 lend for reading, P5 lend for writing, P6 the product surface), the eleven design
decisions D1–D11, and the docs absorption. The issue supersedes the #599 household
model; the retired vocabulary is deleted rather than shimmed, on the repo's pre-1.0
hard-cut policy. Two requirements remain unchecked and are disclosed under **Open
issue requirements**; nothing is silently deferred.

## User impact

Borrowed scopes now mount through the same web, desktop, and mobile replica
sessions as owned scopes. A `read+act` lend can submit offline-safe device intents
and reconcile parked, executed, or structured-conflict outcomes; a read-only lend
still refuses writes. Search over a field-masked borrowed scope reports a refusal
instead of the false claim that there were no matches.

First-run: onboarding and the initial home remain unchanged; the existing desktop
first-run harness emits the evidence image below. The sharing changes begin only
after an owner creates or accepts a link and mounts a borrowed scope.

![First-run shell after the vault share-plane integration](artifacts/e2e/ui-impact/issue-726-vault-as-share-unit.png)

## Checklist

- [x] **P0** — ownership replaces the role lattice. One owner per vault, enforced by
      the `vault_owners` primary key. `DeviceRole`/`GrantableRole`/`member_roles`/
      `roleWithin`/`canWrite(role)` deleted end to end, along with the share-target
      model and the `/share` routes. Gateway protocol floor raised to 3 with no
      COMPAT path. `consent_share` and Photos' household-era **Sharing** place were
      removed. An idempotent migration seeds owners from each vault's earliest admin.
- [x] **P1** — a vault per person. Every vault mints an Ed25519 identity seed
      (`<vaultId>.identity`) into the same KeyStore custody as its DEK, so P3 needed
      no backfill; the recovery kit carries and restores it. "Add someone" mints
      owner, vault, and pair ticket in one operation. Host custody keeps process
      control, stopping hosting, and disk visibility, and loses erase, ticket-mint,
      and backup-target configuration on vaults it does not own (`owner_only`);
      backup runs skip such vaults loudly. The mint screen states host read access and
      unattended signing. Ownerless owners get a vault at boot, once.
- [ ] **P1 household content migration remains required by #726.** The boot sweep
      mints a vault for each ownerless owner, but does not yet move that person's
      content out of the legacy Shared room through closure projection; the current
      implementation explicitly leaves content where it is.
- [x] **P2** — the closure splits into `readShareClosure` (origin, read-only,
      serializable `WireClosure`) and `projectShareClosure` (audience, one
      transaction); `shareToVault` composes them locally with its signature
      unchanged. One closure covers a set of items. Projection is ingest: a
      projected row takes the same door an authored row takes, re-deriving place
      under the audience's own policy and queueing the audience's own enrichment.
- [x] **P2** — `share_edges` succeeds `placement_intents`; three photographs move as
      one edge, one reconcile pass, one receipt. Cross-owner edges require an
      approved link and otherwise refuse `not_found`. `mode:'live'` accepted by the
      table, refused by the route until P4.
- [x] **P2** — the scope kit: `_shared/scope-kit.ts` and `_shared/scope-merge.ts`.
      An app becomes shareable by declaring `{mergeKey, mintedIdFamilies,
      projectionIngest}`; Tasks reads its board across two mounted scopes with no
      sharing-specific code of its own.
- [x] **P3** — a peer plane two gateways speak across: a peer ALPN whose streams
      forward into the local HTTP server, so every peer protocol is ordinary
      TypeScript. Link ceremony with a single-use ticket bound to the proved
      endpoint; peers bind to a vault id and its public key, with the endpoint id as
      replaceable route cache re-asserted under signature. Link redemption performs
      the peer hello/version handshake and refuses incompatible protocol floors before
      consuming the one-time ceremony ticket.
- [x] **P3** — remote give: derivatives cross with the closure so the audience
      paints immediately; originals are recorded remote-only and pulled by sha,
      ranged, resumable, and verified before adoption. Location policy applies to
      exif on cross-owner edges only. The audience may set accept, ask, or refuse
      per link, evaluated before any bytes move.
- [x] **P3** — the peer dial, the blob-pull drain on the sweep, and refusal relay,
      so remote sharing works between two machines rather than only in-process.
      Production dials rebuild an iroh ticket from the vault's current EndpointId
      and cached relay hint; n0 discovery remains transport address resolution,
      never vault identity or authorization.
- [x] **P4** — lend for reading. A live edge mints an ordinary consent grant whose
      grantee is the peer vault, so row filters and field masks work through the
      projection that already honours them. Borrowed rows live in their own store
      per counterparty vault, a sibling of the vault directory. Leases are signed by
      the origin vault's key and expire in thirty days, renewed on every authenticated
      edge contact that keeps the lend open (bootstrap, tail, blob pull, or intent).
      Revocation, expiry, a pushed close, and the audience's own drop converge on one
      deletion path.
- [x] **P4** — reach: the sweep tails each borrowed edge; the borrowed image store
      is filled with pinned rungs; borrowed scopes list read-only beside owned ones
      with a stated mount policy; search answers honestly per scope; a per-link byte
      budget parks and resumes distinguishably from unreachability. The local disk
      report counts the gateway-level borrowed root as **Held for others**, outside
      every vault's backup-bearing footprint.
- [x] **P5** — lend for writing. The audience queues intents; the origin executes
      each through the ordinary invoke path as the edge's grant identity, so
      consent, Tier-3/4 parking, receipts, and the journal are those of an authored
      action. A stale `baseVersions` edit returns a structured conflict, not a
      transport failure. A read-only edge's write is refused by consent itself.
- [x] **P5** — devices reach borrowed rows and submit writes through the borrowed
      replica route, authorized on owning the audience vault rather than on
      enrolment. Parked, executed, and structured-conflict outcomes reconcile back
      through the ordinary replica session.
- [x] **P6** — one share sheet on web and mobile: a give/lend toggle over one
      destination list mixing your own vaults with linked people, never sorted or
      labelled by locality. A People panel with shares in and out, link management,
      receipts, the ask surface, and the receive setting. Revoking reads "stop
      lending"; a give warns it is irrevocable before it happens.
- [x] **P6** — borrowed sections with seat-correct chrome; an unreachable original
      renders "at ⟨person⟩'s vault".
- [x] Every gap that building the surface exposed is closed, not filed — see
      **Gaps the surface exposed** below for the six and where each landed.
- [x] Docs absorbed: SECURITY.md, ARCHITECTURE.md, glossary, protocol, decisions,
      blueprint-seats, and the pairing recovery doc.
- [ ] **Closure evidence still required by #726** — one composed test must recover a
      co-hosted vault onto a second gateway with its link intact, re-find its route
      through iroh discovery without repeating ceremony, then drive remote give,
      ranged pull, refusal, lend, write-back, and revoke. The current composed test
      proves the real peer transport and endpoint rotation, but not recovery +
      discovery continuity.

## What changed

**Ownership replaced authorization.** The role lattice is gone. A vault has exactly
one owner, expressed as a primary key rather than as a rule anyone must remember,
and every question the roles used to answer is now answered by ownership. Devices
belong to owners; owners own vaults; nothing else grants authority. Hosting a vault
stopped conferring the right to act for it: a machine that holds someone else's
vault can stop hosting it and can see it on disk, but cannot erase it, mint pairing
tickets for it, or point its backups elsewhere.

**A vault became something a person has, and something that can prove it is
itself.** Every vault mints an Ed25519 identity seed into the same custody as its
encryption key. That decision is what let P3 put a vault on the wire with no
backfill and no migration, and it is why a link can bind to a vault id and a public
key rather than to a network address.

**Sharing became one substrate with two verbs.** `readShareClosure` produces a
serializable `WireClosure` at the origin; `projectShareClosure` writes it in one
transaction at the audience. Locally they compose; across a wire, a peer plane sits
between them. `share_edges` records the relationship — give as a snapshot, lend as a
live window. `judgeEdgeCrossing` returning a route chooses the remote snapshot
reconciler, while a live edge opens and tails through the lend plane. Both consume
the same edge/link substrate without pretending their replay mechanics are identical.

**A projected row is an authored row.** Content arriving over an edge takes the same
ingest door authored content takes: place is re-derived under the audience's own
location policy, and enrichment is queued under the audience's own ontology, rather
than inheriting the origin's derived state. An audience's *write* is the mirror of
this: it executes at the origin through the ordinary invoke path, so it is subject
to the origin's consent, parks for the origin's owner when the action is sensitive,
and produces the receipt and journal entry an authored action produces.

**Borrowed data lives somewhere it cannot contaminate.** Rows and bytes lent to you
live in a store and CAS per counterparty vault, a sibling of the vault directory
rather than a filtered subset of it — so "borrowed rows never enter a backup or a
hosted copy" is the address, not a rule. Leases expire in thirty days and renew on
every successful authenticated edge contact that keeps the lend open, so an audience
partitioned past expiry forgets on schedule without being told; revocation, expiry, a
close, and the audience's own drop all converge on one deletion path, which is why
dropping is bilateral with no second mechanism.

**The product says true things.** A search that could not reach a scope says so
rather than reporting no matches. A scope whose field mask hides the indexed column
says it refused, at the moment the mask is chosen rather than when a query returns
oddly empty. A row filter cannot leak through pagination because filtered rows never
enter the store. An edge parked for byte budget reads differently from one parked
for an unreachable peer. Revoking a lend is worded "stop lending", never "take
back", because nobody can un-see what they have already read; a give is warned as
irrevocable before it happens.

## Gaps the surface exposed

Building the product surface was the test that found what the layers below it were
missing. Six gaps surfaced this way. Every one of them shares a shape: a capability
that existed, was tested, and could not be reached — code that passed its own suite
while doing nothing for a user. They are recorded here because that shape is the
recurring failure of this branch, not an incident.

| Gap | Why it mattered | Closed in |
| --- | --- | --- |
| `closeLiveEdge` and `dropBorrowedEdge` had no owner-facing route | Both surfaces shipped "Stop lending" / "Stop borrowing" **disabled with a reason**, and an audience had no way to un-mount a borrowed scope | [`edges-close-routes.ts`](../packages/gateway/src/routes/edges-close-routes.ts) — one route resolving origin→close, audience→drop |
| `linkDto()` returned no peer label | The client could only name a linked vault that had already lent something in; everything else read "Linked vault 3f9a2b1c…" | `labelA`/`labelB` in [`vault-links-routes.ts`](../packages/gateway/src/routes/vault-links-routes.ts) |
| Byte budget was a build-time constant | The P6 control called for a budget *per link, per direction*; there was one gateway-wide number | [`lend-budget-settings.ts`](../packages/gateway/src/serve/lend-budget-settings.ts), keyed `(link_id, vault_id)` exactly like the D9 receive setting |
| `lendWireFromEdge` dropped `searchReach` | D10's mask-selection-time warning was correct code reading a field that never arrived — it failed silently rather than loudly | [`lend-wire.ts`](../packages/client/src/react/blueprints/lend-wire.ts) |
| Reach facts were computed and discarded | An unreachable lent scope rendered as an empty list — the precise failure this issue exists to beat | Photos [`app-root.tsx`](../packages/blueprints/apps/photos/app-root.tsx), Tasks [`Board.tsx`](../packages/blueprints/apps/tasks/components/Board.tsx) |
| Three `.test.tsx` suites were never collected | Green by never running (see **Verification**) | `vitest.config.ts` include glob |

The first three were found by the agents building the surface and closed in the same
pass. The fourth and fifth were found by audit. The sixth was found by looking for
the pattern rather than for the file — which is why it covers three suites and not
the two originally reported.

## Decisions

- **One link table (D3).** P2 and P3 each grew a notion of a link — one for two
  vaults on this machine, one for vaults on different machines. Two tables meant two
  answerers for "may this share cross to that vault", which is the semantic split
  D3 forbids. They were merged: both sides carry the identity keypair P1 gave every
  vault, approval is one concept in both localities (two owners approving, or a
  ticket minted and redeemed), and a cached route is simply what a side needs when
  it is elsewhere. `judgeEdgeCrossing` is the only function that answers whether a
  share may cross.
- **The transport is one Rust protocol identifier forwarding into TypeScript.**
  Production gateways run a Rust-owned iroh relay whose accept loop matched exactly
  two protocols and dropped everything else, with no byte path back to JavaScript. A
  TypeScript-only ceremony would have passed every test and done nothing in
  production. Rather than bridging streams across the native boundary or
  reimplementing the peer protocol in Rust, one protocol identifier forwards its
  streams into the gateway's local HTTP server, so every peer protocol from here on
  is ordinary TypeScript.
- **Path confinement lives in the forwarders, not the router.** The HTTP router
  resolves `..` before dispatch, so a peer path could reach an owner handler
  regardless of where the peer routes are registered. The guard is therefore in the
  Rust forwarder and the TypeScript forwarder independently, with the route layer as
  a backstop, and percent-escapes are refused rather than decoded so the two
  languages cannot disagree about what a path means.
- **Peer authorization is not device authorization.** The existing hook asks "is this
  a paired device". A peer plane reusing it would make a peer gateway
  indistinguishable from the owner's own phone. The peer lane authorizes against
  links, on its own control route, and any request still marked as a peer is refused
  before any owner-tier surface — the bearer token is checked above the composed
  handler, and the peer forwarder carries it, so the device-key check alone was not
  enough.
- **The identity seed stays out of the portable export.** The recovery kit means
  "this same vault, elsewhere" and carries the seed; a portable bundle means "this
  data, elsewhere" and restores a vault that mints its own identity. Putting a
  signing key into the artifact designed to be read by other software would be the
  wrong trade. Recorded as an export-completeness audit in `portable-export.ts`.
- **The receive setting is keyed by link and vault, not stored on the link row.**
  Link identifiers are not synchronized between two gateways; only content is.
- **Photos lends its whole library in this pass.** A per-album live edge needs a row
  filter the share sheet cannot express without a query-builder UI. The sheet says
  so when lend is chosen rather than implying a narrower scope than it grants.
- **Quality ratchet re-pin.** #726 classification fingerprints re-pinned after the route authority vocabulary and sealed schema attribution changed; no budget or gate was widened.
- **Phase delivery deviation.** #726 requested one issue per phase, but PR #729
  already contains the seven completed phases as one reviewable history. The
  post-review repair keeps that history intact and adds one composed closure test;
  retroactively splitting the branch would not improve behavioral isolation.
- **Receipt crosswalk deviation.** PR #729 was already a 467-file, seven-phase
  branch when this post-review repair began. The receipt retains a phase-by-phase
  behavioral crosswalk and names the decisive implementation and test surfaces;
  duplicating every historical path into the checklist would make the audit less
  legible without adding evidence.

## Open issue requirements

- **Household content migration remains open.** The idempotent P1 boot sweep gives
  every ownerless owner a vault, but `build-gateway.ts` deliberately leaves existing
  content in place. #726 requires legacy Shared-room content to move through the
  closure projection into the new personal vault. That behavioral migration is an
  in-scope merge blocker and is not claimed by the checked ownerless-vault mint item.

- **Composed recovery + discovery continuity remains open.** The phase suites prove
  recovery preserves the vault identity and the production peer dial enables n0
  discovery from EndpointId plus relay hints. The composed lifecycle now runs its
  remote give/lend/write/revoke sequence over real iroh endpoints and rotates the
  audience endpoint, but it still re-runs link ceremony after that rotation. It does
  not yet recover the initially co-hosted vault onto a blank second gateway with the
  link record intact and re-find it without ceremony, as #726's closure evidence
  requires. This is an in-scope merge blocker, not a deferred product enhancement.

## Out of scope

Knowingly not built, and why:

- **Per-album lend granularity for Photos.** Whole-library only this pass, stated in
  the sheet at the point of choice. A per-album live edge needs a row-filter UI.
- **An SSE lane on the lend plane.** Windowed catch-up and rebootstrap-on-shape-
  change landed; the cadence is the sweep tick. The spec requires only that a stream
  never be the sole authority, which holds.
- **Per-link byte budgets for co-hosted edges.** A co-hosted edge carries a synthetic
  link id that matches no link row, so the budget route cannot address it. Bytes are
  not transferred in that case; the build-wide default still applies.
- **Tasks' own full-text search across scopes.** Its board reads through the kit
  over two scopes, which is the exit evidence; its FTS search stays single-scope.
- **Cross-language conformance for the peer protocol.** `wire-golden.json` is
  deliberately unchanged: it is the Swift and Kotlin clients' conformance to-do
  list, and a phone has no peer links, so adding the peer protocol there would tell
  mobile it owes an implementation it does not.
- **`crossVaultPlacements` capability flag not renamed.** An opaque boolean whose
  meaning is unchanged; renaming ripples into `packages/cli` and contract fixtures
  for no behavioural gain.
- **File-size norm exceeded (limit respected).** `iroh_relay.rs` (608),
  `centraid-inline.ts` (542), and some pre-existing Photos and Tasks components sit
  above the 500-line norm and below the enforced 625.
- **The mobile link door is paste-only.** The web panel shows a QR code and accepts a
  pasted ticket; mobile accepts a pasted ticket with no camera scan.
- **`packages/tunnel/src/gateway-endpoint.test.ts` still pins protocol 2** in a mock
  pairing response — below the current floor. Inert, because that pairing path
  passes the version through and never judges it, but it is the same staleness class
  fixed elsewhere in this branch.
- **`project-closure.ts` reads as binary to git.** A literal NUL byte in a key
  separator predates this branch, so the file's diff is invisible in review. The
  second audit diffed it by hand and confirms this branch's only change to it is the
  `sharedByMember` → `sharedBy` rename.

## Verification

The verification can be reproduced through the repository-owned commands:

```sh
bun run check:pr
bun run test:mutation:pr
bun run test:perf:pr
bun run --cwd apps/desktop test:e2e
bun run --cwd apps/web e2e
```

Post-review verification exercised every `check:full` stage. `bun run check:pr`
passed all 39 push gates and all 35 typecheck tasks; its instrumented suite reported
898 passed / 3 skipped files and 9,920 passed / 35 skipped tests, with **87.9%**
diff coverage (9,026 / 10,267 lines). The uninstrumented affected-package pass
reported 1,098 passed / 4 skipped files and 11,983 passed / 36 skipped tests.
Repository coverage completed, and the schema/export, law-registry, UI-receipt,
classification, and quality ratchets were green.

The affected mutation lane passed without lowering a floor: protocol **90.2%**,
tunnel **87.7%**, and CLI **92.2%**. The peer-plane confinement contract is now in
the tunnel mutation suite as well as the integration suite, closing the initial
false-negative where Stryker selected no test that called `isPeerPlaneTarget`.
Low-end performance passed every budget (request p99 16.8 ms, event-loop peak p99
3.8 ms, 248 MiB peak RSS). Desktop Playwright passed 60 tests with 4 intentional
skips; web Playwright passed all 15 tests. The desktop run emitted the first-run UI
evidence linked above.

The composed closure test now boots two HTTP + iroh endpoint artifacts, rotates the
audience endpoint, and drives remote give, ranged pull, refusal, lend, write-back,
and revoke over real `centraid/gw-link/1` connections. It does not yet prove the
issue's required recovery + discovery continuity; that gap is explicitly unchecked
above. Focused peer-transport tests keep relays disabled for deterministic offline
CI; production `startPeerDial` reconstructs tickets from the cached EndpointId/relay
hint and enables n0 discovery. Live-edge blob pulls and write intents now carry a
new vault-signed lease; the borrower verifies it against the pinned origin key
before renewing the stored shape lease.

Exit evidence lives in behaviour tests, not assertions about structure: two
gateways complete a ceremony and a remote give over the real peer transport
(`peer-transport-remote.test.ts`, `peer-link-ceremony.test.ts`,
`peer-remote-give.test.ts`); a lent scope bootstraps, tails, revokes, and expires
(`lend-live-edge.test.ts`, `peer-plane-sweep-lend.test.ts`); a lent scope is written
to from both ends with a structured conflict (`lend-write-back.test.ts`); path
confinement is asserted in Rust and TypeScript against the same refusal table
(`iroh_relay.rs` tests, `peer-plane.test.ts`); a peer-marked request is refused
before every owner-tier surface (`build-gateway-peer.test.ts`).

Two test files were fixed for pinning a protocol version that this issue's floor
bump invalidated — `apps/mobile`'s compatibility judge and `packages/cli`'s contract
fixture both asserted that a current gateway needed updating. Both now state the
cases against `GATEWAY_PROTOCOL_VERSION` and its minimum, so the same staleness
cannot recur at the next breaking release.

A third staleness was worse, because it was silent. `packages/blueprints/vitest.config.ts`
included `src/**/*.test.ts` and `apps/**/*.test.ts` — both patterns ending `.test.ts`,
neither matching `.test.tsx`. Three component suites therefore contained real
`describe`/`it` blocks that had never executed once: `apps/_shared/SearchScaffold.test.tsx`,
`apps/photos/components/People.test.tsx`, and `apps/tasks/components/Board.test.tsx`.
They were green by never running, which is the failure mode a coverage number cannot
see. The glob now matches `.test.tsx` under both roots; the three files collect and
contribute 58 cases, and the assertions that could never have passed were fixed rather
than deleted. The audit that found this looked for `.test.tsx` files across the whole
package rather than only the two it had been pointed at — which is how the third one
was found.

## Audit

### Round 1 — REFUTED

- **REFUTED — `What changed` matched the final diff.** It incorrectly said one
  reconciler served snapshot gives and live lends, although the diff has separate
  snapshot reconciliation and live open/tail paths.
- **REFUTED — every checked item was implemented and verified.** Blob-only live-edge
  contact did not renew the lease, and the composed closure test used the in-process
  peer transport instead of two endpoint-backed gateway artifacts.
- **REFUTED — the checklist mirrored issue #726.** It omitted explicit P3 iroh
  discovery, P4 **Held for others** storage accounting, and the composed two-artifact
  closure evidence requirement.

The implementation and receipt were repaired in response; Round 2 below records the
fresh-context re-audit of those changes.

### Round 2 — REFUTED

- **REFUTED — `What changed` matched the final diff.** The reconciler wording was
  repaired, but “renew on contact” still overclaimed because authenticated write
  intents returned no lease.
- **REFUTED — every checked item was implemented and verified.** Blob renewal and
  **Held for others** accounting were real, but the composed test restarted an
  endpoint rather than recovering a co-hosted vault onto another gateway, and it
  re-ran ceremony instead of proving discovery continuity.
- **REFUTED — the checklist mirrored issue #726.** It named the Round 1 omissions
  but still omitted the peer version handshake, mint-screen read/unattended-signing
  posture, and removal of Photos' household-era **Sharing** place.

The intent path and checklist were repaired. The recovery/discovery closure gap is
now an explicit unchecked merge blocker rather than a checked overclaim; Round 3
records the next fresh-context verdict.

### Round 3 — REFUTED

- **REFUTED — `What changed` matched the final diff.** A repair accidentally said
  `readShareClosure` produced the audience transaction; the diff assigns that
  transaction to `projectShareClosure` and the wire closure to the read half.
- **REFUTED — every checked item was implemented and verified.** Intent lease
  renewal, mint posture, and Photos-place removal were confirmed, but the checklist
  overclaimed that version judgment guarded all edge traffic; the implementation
  judges compatibility during link redemption.
- **REFUTED — the checklist mirrored issue #726.** It still silently omitted the P1
  requirement to migrate legacy Shared-room content through closure projection; the
  implementation only minted missing personal vaults and left content in place.

The closure wording and handshake scope are now exact. Household content migration
is an explicit unchecked merge blocker beside recovery/discovery continuity; Round 4
records the next fresh-context verdict.

### Round 4 — PASS

- **PASS — `What changed` faithfully describes the final diff.** The diff implements
  the described ownership model, closure split, edge/link substrate, peer transport,
  borrowed stores, lend intents, and product surfaces; the receipt separately and
  accurately discloses the two absent behaviors.
- **PASS — checked checklist items are implemented and verified.** Evidence includes
  closure serialization/ingest tests, ceremony-scoped mutual version judgment before
  ticket consumption, remote give/lend/write/conflict/refusal tests, owner-only and
  recovery-identity tests, borrowed-scope/search/UI suites, and `.test.tsx` collection.
  Neither unchecked blocker is claimed by a checked item.
- **PASS — the checklist mirrors issue #726 without silent omission.** P0–P6 and docs
  absorption map to the issue's phase checklist. P1 Shared-room content movement and
  the composed recovery/move/discovery closure evidence are explicitly unchecked;
  the receipt does not overclaim either.

Earlier fresh-context audits also read the code rather than the summaries that
produced it; their findings and repairs remain below as historical evidence.

**The first refused to merge**, and it was right. Its decisive finding: the remote
link ceremony had no user-facing door. `PeerLinkTicketStore.mint` and
`redeemLinkTicket` were reachable only from tests, and `vault-links-routes.ts`
refused any link whose other vault was not local — so every remote capability P3
through P6 claimed was demonstrable in process and unreachable in production. It
named this the third instance in this branch of the same class the work had already
caught twice (the Rust protocol allowlist, then the missing peer dial), surviving
this time at the ceremony itself. It found three more blocking defects: per-scope
search reach computed and discarded at every layer, so the Tasks board rendered an
unreachable lent list as an empty list — the precise failure this issue exists to
beat, in the app chosen to prove the scope kit generalises; a storage screen that
threw a TypeError on any borrowed bytes, invisible to the type-checker because it is
a wire boundary; and peer identity collapsing when one remote gateway hosts two
linked vaults, since links were looked up by endpoint alone and an endpoint belongs
to a machine, not a vault — contradicting D2 at the seam D2 is about. Four further
findings were non-blocking: the household-era share control still rendered to users
in Docs and Tally, `shared_by_member` surviving with schema weight, a comment
asserting a constant pin no test performed, and the protocol-floor staleness class
persisting in three more fixtures.

It also tried to break the security boundary and could not. It probed `..`,
`%2e%2e`, backslash, `//`, bare-prefix, and query and fragment smuggling against the
peer path confinement, and found the three layers agree by construction rather than
by luck — the guards demand a strict extension of the prefix and refuse
percent-escapes instead of decoding them, so the two languages cannot disagree about
what a path means. It confirmed a peer cannot satisfy an owner-tier check by any
route, that a link ticket cannot be redeemed twice or burned by a version-mismatched
peer, and that borrowed rows are excluded from backups by address rather than by a
filter. It judged the merge of P2's and P3's link tables correct: nothing the two
tables expressed was lost.

**The second audit verified the fixes and would merge.** It traced each finding from
the code — routes registered and reachable from both surfaces, a co-hosted fixture
that genuinely shares one gateway database and endpoint rather than simulating it,
reach panels rendering beside results that did arrive, and a mount-cap pin that fails
when any of the three copies drifts. It confirmed the ticket's single-redemption and
version-wall properties survived the change, and that no new silent fallback was
introduced while removing the old ones.

Its remaining observations are recorded under **Out of scope** rather than fixed,
except three closed immediately after: a dead peer-vault header stamped through the
deliberately coarse endpoint-only lookup with a comment claiming a guarantee that no
longer held; an untested coupling that borrowed thumbnail pulls silently depend on;
and a redeem route that answered an absent capability as though it were an
unreachable network.

The post-review repair closed the second audit's remaining user-facing gap rather
than retaining it: field-unavailable metadata now raises a typed replica search
refusal, survives worker serialization, and reaches `SearchScaffold` as an explicit
scope refusal. Tests pin the store, worker, and UI interpretation so a masked scope
cannot regress to a false empty result.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-09 | codex | 019fe4e5-929d-7d91-8679-18150f8805bc |
