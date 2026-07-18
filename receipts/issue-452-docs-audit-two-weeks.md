# Issue #452 — docs: comprehensive audit — catch the docs up to the last two weeks

GitHub issue: [#452](https://github.com/srikanth235/centraid/issues/452)

The docs site and root README/ARCHITECTURE had drifted behind two weeks of
shipped work. A four-agent recon pass (docs claim inventory + three
ground-truth briefs sourced from code) fed six parallel rewrite agents, one
per chapter group; the orchestrating session reviewed every diff, swept for
residual stale terms, and verified the built site page by page.

## Checklist

- [x] Apps chapter: replace the builder section with the install model
- [x] Start tutorial: install flow, real sidebar, web PWA path, native mobile and replica notes
- [x] Devices chapter: web app client home, replica protocol section, native mobile rewrite, relay-only transport tier
- [x] Data chapter: ontology 1.3 and the bounded conversation ledger
- [x] Backups chapter: recover verb, hosted-vs-local home connection, five-metric surface
- [x] Understand map: install framing, Atlas/ledger/replica/recovery index rows
- [x] Ontology deep-dive: poly-ref registry, bounded-ledger stance, builder gating, Vault Atlas pointer
- [x] Learn primers: offline replica nuance in the p2p primer
- [x] README and ARCHITECTURE aligned with shipped reality
- [x] docs:build, docs:smoke and a rendered-page check pass

## What changed

**Apps chapter: replace the builder section with the install model.**
`scripts/docs-site/src/content/apps.html` — the hero lede and §04 drop the
"describe the change, publish" builder narrative for the shipped install
model (#434): install writes a consent record plus declared-scope grants,
nothing is copied, apps serve from the release and upgrade with it, uninstall
revokes access but keeps data. The §04 artifact mock is now the real Install
sheet ("What Docs can access", **Read** / **Add & change**, the verbatim
"Nothing is copied" footer) with scopes drawn from the Docs `app.json`; an
honest note explains the builder machinery still compiles automations but has
no user-facing surface in v1. The §01 ext-band paragraph now matches the
gateway-creates-tables/uninstall-keeps-rows reality, the People card says
Lists (not Circles, #441), and §07 mobile describes WebView-over-tunnel
installed apps alongside native Photos/Docs/Agenda over the offline replica.
`scripts/docs-site/src/pages/apps.astro` mirrors the rail (`#builder` →
`#install`, "The builder" → "Installing") and fixes SEO description/keywords.

**Start tutorial: install flow, real sidebar, web PWA path, native mobile and
replica notes.** `scripts/docs-site/src/content/start.html` — §03 replaces
"cloning one is a single click" with the Install sheet flow and
uninstall-keeps-data; §02 describes the real sidebar (Pages: Home, Assistant,
Insights, Discover, Starred, Automations, Approvals; Operations: Gateway,
Backups, Vault Atlas); §07 enumerates the three client homes including the
ticket-paired web PWA; §06 adds the native Photos/Docs/Agenda + offline
replica paragraph (linking Devices § replica) and the native dev-build
caveat; the closing key aside points at the blank-machine `recover` flow.
`scripts/docs-site/src/pages/start.astro` title/description/keywords drop the
clone/builder framing.

**Devices chapter: web app client home, replica protocol section, native
mobile rewrite, relay-only transport tier.**
`scripts/docs-site/src/content/devices.html` — new §05 Replica documents the
consent-scoped offline replica (#406/#417): the in-transaction
`replica_change` log, server-derived shapes (grants ∩ trust tier),
bootstrap/changes/checkpoint flow, idempotent intents with parked/denied
outcomes, and epoch-based re-bootstrap — framed as offline without a second
writer. New §07 Web app covers the PWA's ticket-only relay iroh/WASM path and
the Origin-bound HttpOnly fallback (#392/#393). §08 Mobile is rewritten for
native Photos/Docs/Agenda over on-device SQLite, background upload, the
custody-gated "Free up space", and WebView remote apps (#431). §04 adds the
relay-only transport tier; §03 adds the one-bit-enrollment/trust-tier
paragraph; §09 corrects Codex as the default agent and adds the
per-subsystem routing lanes (#432). `scripts/docs-site/src/pages/devices.astro`
mirrors the new nine-section rail.

**Data chapter: ontology 1.3 and the bounded conversation ledger.**
`scripts/docs-site/src/content/data.html` — the version claim moves from
`ontology 1.2` to `ontology 1.3` (`packages/vault/src/schema/migrate.ts`);
§01 gains the bounded-ledger paragraph (#438): idle conversations digest,
seal into CAS segments, prune only behind the custody latch, rehydrate lazily
read-only, Insights unaffected; §06 adds one sentence keeping connector sync
distinct from the device replica; §09 aligns a phrase with the Hosted vault
framing.

**Backups chapter: recover verb, hosted-vs-local home connection, five-metric
surface.** `scripts/docs-site/src/content/backups.html` — the hero and §02
adopt the hosted-vs-local binary (#436): one managed home connection wired in
Settings → Account → Storage, bring-your-own buckets retired; the CLI block
adds `backup restore-verify` and the top-level `recover` verb; §04 states
restore is lazy by default (`--full`, `--at` PITR, never swaps the live
vault) and adds the recover-as-product walk (#439): first-run Start fresh /
Recover my vault, the three-stage narration, fencing at generation + 1, and a
new orphan-grace GC step; §05 is reframed around the Operations → Backups
page with the five metrics (Freshness, Recovery window, Privacy, Cost, Exit)
and the Diagnostics clock grid; §06 replaces the BYO-S3 credential recipe
with the `/v1/storage/*` home-connection framing.

**Understand map: install framing, Atlas/ledger/replica/recovery index
rows.** `scripts/docs-site/src/content/understand.html` — the Apps card and
index row swap builder framing for installing; the Devices card names the web
app, native mobile, and the replica; the ontology callout reconciles to
twelve ontology packs over six machinery bands
(`packages/vault/src/schema/atlas.ts`) and names Vault Atlas; new index rows
cover vault atlas, the conversation ledger, mobile & replica, and recovery.

**Ontology deep-dive: poly-ref registry, bounded-ledger stance, builder
gating, Vault Atlas pointer.** `scripts/docs-site/src/content/ontology-body.html`
— the "Since v1.1" changelog gains #441 (poly-ref registry, favorites/lists
unification), the runtime-store stance gains the #438 bounded-ledger
addendum, and a #436 clause; the gateway-contract standing duties name the
poly-ref registry cleanup; §12 states the builder prompt machinery is built
but gated off for v1 (`builderEnabled`, #434); the stale hardcoded FK count
is softened; the §03 lede points at the in-product Vault Atlas (Kinds /
Relations / Browse). The data-driven `SCHEMAS` array is deliberately
untouched (its scope is the 11-schema logical model; machinery bands stay
prose).

**Learn primers: offline replica nuance in the p2p primer.**
`scripts/docs-site/src/content/learn.html` — the §06 peer-to-peer primer
closes with consent-scoped offline replicas, intents settling on reconnect,
and still exactly one canonical writer.

**README and ARCHITECTURE aligned with shipped reality.** `README.md` — lead
and feature bullets move from build-by-chatting to install + agents framing
(builder noted as hidden for v1), add Vault Atlas, the PWA ticket pairing,
native mobile over the replica, and Hosted-or-on-device with `recover`;
volatile test counts softened; the Apps docs row says install model.
`ARCHITECTURE.md` — additive paragraphs cover Vault Atlas over the journalled
command path with the poly-ref registry (#441), the bounded conversation
ledger (#438), the two restore verbs with lazy `recover()` and fencing
(#439), and a new Device replicas section (#406/#417).
`scripts/docs-site/src/content/index.html` and
`scripts/docs-site/src/pages/index.astro` — the landing hero and SEO copy
drop "built and rebuilt by an agent" / "app builder" for install + agents
wording.

## Out of scope

- `packages/blueprints/README.md` and the `packages/blueprints/src/index.ts`
  header docstring still describe the pre-#434 clone-and-deploy model —
  flagged as a separate follow-up task.
- Restructuring the ontology page's `SCHEMAS` array to the 12-pack/6-band
  framing (the page's internal 11-schema logical-model scope is
  self-consistent).
- New standalone chapters (e.g. a dedicated replica or Atlas page) — coverage
  was folded into the existing chapter structure.

## Decisions

- Kept the docs' hand-authored editorial voice by briefing rewrite agents
  with per-page fix briefs plus code-verified ground-truth files, and
  requiring surgical edits over wholesale rewrites.
- The devices chapter frames the replica as how the single-writer star
  supports offline devices — strengthening, not weakening, the no-multi-master
  thesis the chapter is built on.
- The ontology deep-dive keeps its internal "eleven schemas" count because it
  matches what the page's own data array renders; the understand chapter uses
  the current 12-pack/6-band product framing with a pointer to the chapter.
- "sync" vocabulary: connector ingest stays "connections/sync"; device data
  is consistently called the "replica", matching the code's two unrelated
  meanings.

## Verification

```sh
bun run docs:build
bun run docs:smoke
```

docs:build, docs:smoke and a rendered-page check pass:
`docs:build` emits all 10 pages and the Pagefind index; `docs:smoke` reports
"10 pages OK, all internal links resolve" (covering the new `#install`,
`#replica`, and `#web` anchors and every cross-page link the rewrite added).
The built site was then served locally and read in a real browser: the
devices chapter renders its new nine-section rail with §05 Replica and §07
Web app, the apps chapter renders the install-model copy, and the ontology
page's inline JS still executes (live counters render 11 schemas / 73
relations / 130 foreign keys; zero console errors) — confirming the prose
edits did not break the data-driven page. Facts were verified against code by
the recon/rewrite agents (`packages/gateway/src/routes/replica-routes.ts`,
`packages/gateway/src/backup/recover.ts`, `packages/vault/src/schema/{migrate,atlas,replica,poly-refs}.ts`,
`packages/client/src/react/screens/*`, `apps/web/src/iroh-transport.ts`,
`apps/mobile/`).

## Audit

PASS — The diff matches the issue checklist: every chapter listed is touched
with exactly the corrections named, the four rail/SEO shells
(`apps.astro`, `devices.astro`, `index.astro`, `start.astro`) mirror the
content changes, no code files are modified, and the claims added are
sourced from the shipped code paths cited in Verification. The builder is
consistently described as hidden-for-v1 across all pages that previously
promoted it; the ontology version reads 1.3 everywhere it is named.

## Steering

PASS — no human-steering events occurred in the issue #452 session: the sole
user message is the opening /goal directive that defines the task (audit the
docs, orchestrate with Opus subagents); all subsequent turns are automated
task notifications with no mid-task redirection.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-e3ddd6ce-def-1784318648-1 | claude-code | e3ddd6ce-defe-4bf3-8fee-e2f30bdcfc61 | #452 | claude-fable-5 | 333 | 572573 | 26104330 | 207848 | 780754 | 43.6572 | 333 | 572573 | 26104330 | 207848 | docs: comprehensive audit — catch the docs up to two weeks of shipped work (#452 |
| claude-code-e3ddd6ce-def-1784318705-1 | claude-code | e3ddd6ce-defe-4bf3-8fee-e2f30bdcfc61 | #452 | claude-fable-5 | 8 | 18544 | 961271 | 1913 | 20465 | 1.2888 | 341 | 591117 | 27065601 | 209761 | docs: comprehensive audit — catch the docs up to two weeks of shipped work (#452 |
