# Issue #928 — one authority plane: retire the app grant evaluator; first-party apps are not principals

Umbrella receipt. One receipt for the whole umbrella; each wave appends its own section.

## Checklist

- [ ] `evaluateAccess` has no `app` identity path; the app bridge issues no app credential; an owner-device read of the owner's vault runs 0 grant statements
- [ ] Replica shapes are composed statically from the app manifest and the sealed registry; shape ids for all eight apps are unchanged on the golden vault; a sealed column name appears in no shape
- [x] The static tripwire fails a build in which an app query touches an undeclared entity (proven with a seeded violation)
- [ ] `access_grant`, `access_grant_scope`, `access_policy`, `access_scope_tombstone`, `access_scope_request` and every reader of them are gone; `grep -r "dpv:" packages apps` is empty outside receipts and CHANGELOG
- [ ] Every automation's standing answer is a `share_authority` row with `principal_kind = 'automation'`; the owner's prior refusals survive as `declined` rows (count and content asserted by the migration test); a widened manifest still parks
- [ ] The assistant holds no standing grant; its reads and writes are receipted exercises on behalf of the acting owner; scheduler-fired automations are capped by their row
- [ ] `access_receipt` references `authority_id` from one id space; the purpose column is gone; the chain verifier is green; Settings → Access shows last-used for every row
- [ ] Companion attenuation and outbox grants are rows in the one plane; `grant_profile_json` has no reader
- [ ] The give-plane coordinator, edge store, effects, edge routes and retire pass are deleted; moving an album between two of the owner's vaults is one command
- [ ] Locker: sealed set, permits, reveal and `ONLINE_ONLY_ACTIONS` unchanged; its history query filters in SQL; `locker-online-only.test.ts` green
- [ ] Authz deny matrix, automation clamp sweeps and the harness parity integration test green at every slice exit
- [ ] `docs/decisions.md`, SECURITY.md and `docs/vault-ontology.md` state the model above; the drift register rows for the consent plane are closed

Ticked by the wave-1 root doc commit: **box 3 only**, realized in full by w1b. Wave 1a itself wrote the rulings only; every remaining criterion needs code, and the last one needs both halves — the three docs state the model now, but the drift register rows are **open**, not closed, so that item stays unticked until the waves that close them land. Wave 1c (`principal_kind` gains `automation`) ticks nothing either, by its own account: the plane now **accepts** an automation answer and nothing writes one, while box 5 also requires the migration, the `declined` rows and the parking behaviour, all of which land in wave 3.

## What changed

Wave 1a is docs-only. It records the rulings #928 makes as current state, so later waves are built over a written answer rather than a guess.

- **`docs/decisions.md`** — new section `## One authority plane (#928)`, placed immediately before `## Related docs`: the four principal kinds with where each is enforced; eight rulings `AP-principals`, `AP-apps-declare`, `AP-owner-direct`, `AP-automation-principal`, `AP-one-id-space`, `AP-attenuations`, `AP-give-residue`, `AP-locker-boundary` stating A1–A7 of the issue as current decisions; the v0 delete-with-replacement stance; the two open questions the root adopted (third-party apps → `app` stays reserved and unwritten; a scheduler-fired automation's principal → one row per automation, not per pack) and the two left open by design (`sqlAsOwner` in wave 3, owner-direct read receipts with #922 B1). Below it, `### The rulings, re-judged (#928)` reproduces the issue's register as a table of Seam | Ruling cited | Property that depends on it now | Verdict — thirteen rows, ten findings, two kept-and-re-homed with the property named, one "holds" row for the spine. No row says "deliberate", and no row is kept without a property.
- **`docs/decisions.md`** — five rows added to `## Superseded decision pointers`: #306 "installing is the consent", #883 V-split's app carve-out, #873 L-access's "the rowFilter is the boundary", #308's tombstones and scope requests (re-homed as `declined` rows for automations), and the assistant's standing `act` grant. Each names #928 and its replacement. The existing `V-split` row in the Grants v2 table gains one appended sentence marking it superseded in part; no other existing text is rewritten.
- **`SECURITY.md`** — the five-layer bullet now says L2 is closed by #928 and carries a second bullet with the four principal kinds and their enforcement points, stating plainly that a first-party app is not a principal and that its reach is fixed at build time by a declared entity manifest plus a static tripwire. The agents bullet's admission that scheduler-fired automations run uncapped is marked **closed by #928 A3** — they act under an explicit `automation` row — with the wave that lands it named. The threat table's `Consent` row is rewritten the same way. L4 attribution keeps its "scheduler-fired automations carry none" admission, now dated — it holds "until their `automation` row lands in #928 wave 3" — because attribution today is unchanged; and "the journal records" becomes "the audit band records", the current name since #916. Every sentence that would claim code not yet landed says instead which wave lands it. No other SECURITY.md sentence changed.
- **`docs/vault-ontology.md`** — six rows added to `## Drift register`, each `open — closes in #928 wave N` with the mechanism named: **ONT-16** the app grant tables, **ONT-17** purposes and the DPV vocabulary, **ONT-18** `access_policy` and its two consultations per non-owner read, **ONT-19** the receipt's four id spaces, **ONT-20** `grant_profile_json` and `outbox_grant`, **ONT-21** the give-plane residue. No row is closed by this slice.
- **`docs/glossary.md`** — `principal` gains `automation` and states the clamp as its locus; new entries define **automation** (principal kind), **app** (reserved principal kind), **authority_id** and **owner-direct read**; the `consent / grant` entry stops calling app grants strategy machinery beneath manifests; two rows in the broader forbidden-synonyms table retire "purpose" / `dpv:` and "app grant" / "consent-scoped app handler", each pointing at #928. Every entry whose sentence would describe code that has not landed names the wave that lands it (the `automation` kind in waves 1 and 3, `authority_id` in wave 4, the app credential in wave 2), and the same wave-naming was added to the #873 supersession row.
- **`receipts/issue-928-one-authority-plane.md`** — this file, created as the umbrella receipt.

Added by the wave-1 root doc commit (see `## w1 root doc commit` below), so the one ticked box crosswalks to evidence in this section: **The static tripwire fails a build in which an app query touches an undeclared entity (proven with a seeded violation)** — realized by w1b in `packages/blueprints/src/app-entity-tripwire.ts` and `app-entity-tripwire.test.ts`, registered as a law and a flow in `tests/claims.json` / `tests/floors.json`, and demonstrated red on 2026-09-03 against the real tree on both halves (an undeclared read of `schedule.project` from `packages/blueprints/apps/tasks/queries/board.ts`, an undeclared `act` on `locker.purge_item` from `packages/blueprints/apps/locker/actions/purge-item.ts`), each restored immediately after, plus four further seeded violations that run on every build. The failure names the app, the file and the entity. Full evidence, numbers and three verifier passes are in `## w1b — the static app entity tripwire`.

## Out of scope

Every code change #928 names: the static tripwire (wave 1b), the vault schema's `automation` principal kind (wave 1c), static shape composition (wave 2), the principal moves and the migration (wave 3), evaluator retirement and the receipt re-key (wave 4), attenuations and the give-plane residue (wave 5). `ARCHITECTURE.md` is untouched — its rewrite lands with the code waves. No test, ledger, budget or allowlist was touched.

## Verification

```sh
bun run format
bun run lint
bun run lint:product
bash .governance/run.sh
bun run check:push
```

## Decisions

- **The drift register rows are opened, not closed.** The contract for this slice and the register's own convention agree: a finding whose mechanism has not landed is deferred and says so. The acceptance criterion that names them therefore stays unticked even though the three docs now state the model.
- **`docs/vault-ontology.md`'s "Was the starting design right?" §2 still says the `access` plane survives as "the machinery beneath manifests, and nothing else".** That sentence is contradicted by AP-owner-direct but describes a mechanism that is still in the code today; rewriting it now would claim a deletion that has not happened. It is re-stated in the wave that deletes the machinery (wave 4), and ONT-16 is the register row that keeps it from being forgotten.
- **The `consent / grant` glossary entry was adjusted beyond the four terms the contract named.** It asserted the exact carve-out #928 supersedes ("App and device scope grants are strategy machinery beneath manifests"), so leaving it would have left a defined term contradicting the ruling on the same page.
- **CI fingerprint re-pin.** #928 re-pins classification fingerprints after the authority-plane migration changed the governed manifest and claim statements, and after merging current main's ledger updates; thresholds and classifications are unchanged.
- **SECURITY.md's "Cannot: protect against a malicious app the owner installed with broad grants" is left alone.** It sits in the transport section, is still true of the code as it stands, and rewriting it belongs to the wave that removes the grants it names.

## Audit

Verdict: PASS

Fresh-context verifier on `claude/928-w1a-rulings` at `8401083a`, wave 1a (rulings, SECURITY.md, ontology drift register).

- **Scope.** `git diff origin/main...HEAD --name-only` is exactly the five in-scope paths (`SECURITY.md`, `docs/decisions.md`, `docs/glossary.md`, `docs/vault-ontology.md`, `receipts/issue-928-one-authority-plane.md`); one commit, no code, test, ledger, budget or lint-config change. `## What changed` names all five and describes each faithfully — no file undescribed, nothing described that is not in the diff.
- **Checklist ↔ issue.** The twelve `## Checklist` items are byte-identical to #928's acceptance criteria (diffed against the issue body). Nothing is ticked; every criterion needs code, so nothing is over-claimed.
- **No claims of landed code.** Every mechanism sentence in the diff names the wave that lands it: the new SECURITY.md L2 bullet ("the ruling is in force ahead of its code … until then an app handler still carries a grant-scoped credential"), the agents bullet ("it lands in #928 wave 3, and until it does those runs remain uncapped"), the L4 admission ("until their `automation` row lands in #928 wave 3"), the rewritten `Consent` threat row ("deleted across #928's waves 2–4"), the decisions section preamble, and the glossary's `automation` / `authority_id` / `owner-direct read` entries. No sentence asserts that `evaluateAccess`, the app credential or the grant tables are already gone.
- **Register.** `### The rulings, re-judged (#928)` is a table of thirteen rows, each with an explicit "Property that depends on it now": ten `finding` (property = none, with the count or source), two `kept, re-homed` with the property named (an automation's own manifest re-asking without a `declined` row; a companion device confined to surfaces), one `holds` for the spine. No row survives on a citation; grep for "deliberate" / "by design" / "kept per #" / "intentional" in the touched docs returns only "deliberately not decided here" about OQ2/OQ3, which names the place that decides each.
- **Contract items.** Section `## One authority plane (#928)` sits immediately before `## Related docs`; five new `## Superseded decision pointers` rows (#306, #883 V-split, #873 L-access, #308, the assistant's standing `act`); the `V-split` row gains one appended supersession sentence and nothing else; OQ1 (`app` reserved and unwritten) and OQ4 (one row per automation) adopted; OQ2/OQ3 stated as decided later. Six drift rows ONT-16…ONT-21 added, all `open — closes in #928 wave N`; no register row closed or altered.
- **Anchors.** `bash .governance/run.sh` → `internal-doc-links` and `doc-integrity` both green; the cross-references used (`#one-authority-plane-928`, `#grants-v2--one-authority-plane-883`, `#ontology-v0-close-916`, `#night-watch-v2-915`) resolve to real headings in `docs/decisions.md`.
- **Gates run.** `bun run format` then `git diff --stat` → empty. `bun run lint` → clean. `bash .governance/run.sh` → 20 passed; failures only `repo-hygiene` (`packages/blueprints/apps/locker/queries.test.ts`, 638 > 625 — pre-existing on `origin/main`) and `receipt-per-issue` (this `## Audit` section, now written). Receipt `## Verification` block re-run: `bun run format` green, `bun run lint` green, `bun run lint:product` → 37/39, failing only the pre-existing `test:ratchet` / `lint:ledgers` "unknown predecessor schema-migration-corpus"; `bun run check:push` → 14/17, failing `lint:product` (same two), `design:gallery` (environment) and `test:qualities` — the last a 30 s timeout in `user-facing-qualities.test.ts` R3 under the parallel gate run that passed on an isolated re-run (`bun run test:qualities` → 10 files, 60 tests, all green), and causally impossible for a docs-only diff.
- **Falsification attempts.** (1) Searched every added sentence in `SECURITY.md`, `docs/decisions.md` and `docs/glossary.md` for a fait-accompli claim about code — the closest is the `Consent` threat row's present tense, which is disambiguated inside the same row and by the L2 bullet above it; nothing refuted. (2) Tried to find a register row or supersession kept on a bare citation, and a drift row silently marked closed — every register row carries a property-or-none column, and all six new ONT rows are `open`.

## Session

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-09-04 | claude-code | 60f9e86b-149f-5fc9-84c0-f2160b6b6f3c |
| 2026-09-04 | codex | 01a06aae-4aeb-72f0-b2a6-97f24ffc02ed |
| 2026-09-04 | codex | 01a06cb4-14e6-7ae3-a265-663bd6c39c1e |

## w1b — the static app entity tripwire

Wave 1(b) of #928: Decision A1(ii), acceptance box 3. Minimisation moves from the runtime grant evaluator to a build-time check over `app.json#vault.scopes`, with a reviewable diff and zero runtime cost — the gate that lets wave 2 delete the evaluator's app path. Three verifier passes are recorded verbatim under `### Audit`, with what each refuted and how it was closed.

Files: `packages/blueprints/src/app-entity-tripwire.ts`, `packages/blueprints/src/app-entity-tripwire.test.ts`, `packages/blueprints/src/app-entity-tripwire.filters.json`, `tests/claims.json`, `tests/floors.json`, `tests/quality/classification-ratchet.json`.

**No `app.json` changed in any commit of this slice**, so no app gained a scope and the no-widening invariant holds trivially; the `manifest-scope-denial.*` sweeps are untouched.

### What changed, file by file

`packages/blueprints/src/app-entity-tripwire.ts` holds the rules and touches no filesystem: `declaredScopes` folds an `app.json`'s `vault.scopes` into read entities, read schema bands, act commands and act bands (`read` and `reveal` both reach rows, `act` invokes a command); `referencesIn` extracts the two precise call-site forms from one file's text; `findUndeclared` reports every reference no manifest carries; `filtersOf` lists a manifest's `rowFilter`/`fieldMask` scopes; `formatFinding` prints `app: verb "entity" in file`.

`packages/blueprints/src/app-entity-tripwire.test.ts` supplies the tree: for each of the eight bundled apps, its `queries/*.ts`, `actions/*.ts` and everything under `apps/mobile/src/apps/<id>/`, plus one hop of relative imports. It asserts the scan is not vacuous (every app has files and declares reads, and at least 60 distinct commands are matched — 134 today), pins the filters fixture, and carries the seeded reds.

`packages/blueprints/src/app-entity-tripwire.filters.json` is the wave 2/4 work order.

`tests/claims.json` gains the law and the flow, mirroring `one-computation`'s registration.

### The finding list: empty, and why that is the honest answer

The issue expects wave 1(b) to list undeclared references found today. **There are none, on either verb.** Rather than manufacture one, here is why, checked rather than assumed:

- **The read half was already enforced.** `packages/blueprints/src/app-manifest-reads.test.ts` (#883) has guarded "apps/`<id>` reads nothing it has not declared" since the manifest matrix landed. A tree that has been green under that test for months has no undeclared literal reads left for a second scanner to find. The new test does not duplicate it: that one holds the hand-kept `READS` matrix so a new read scope is a decision made twice; this one fails the build on the reference itself and covers ground the matrix test does not (below).
- **The act half is new, and is also clean.** Nothing checked an app's `command:` invocations against its `act` verbs before this slice. 134 distinct command references across the eight apps were resolved and every one is declared. The nearest existing directive, `handler-contract`'s `declared-writes`, is about `app.json#actions[].writes` — app-local SQLite tables — and says nothing about `vault.scopes`.
- **Three apparent findings were false and are not suppressed by an allowlist.** A first pass attributing a mobile read to the directory holding it reported `docs → core.vault`, `photos → core.vault` and `photos → tally.group`. All three are scope-named at the call site (`useReplicaQuery("people", { entity: "core.vault" })`), which is the pooled-scope rule `app-manifest-reads.test.ts` already states: a seat names the scope, so the read is attributed to that scope and never to the directory it sits in. The tripwire reuses that rule, and a test pins it on the real file so the rule cannot be quietly dropped. A read named for a scope no app declares is still charged to the app that wrote it, so a typo'd scope fails rather than vanishing.

Findings **fixed** in this slice: none, because none exist. Findings **listed as not fixable here**: none. No manifest scope was added, so no app gained reach it did not have — the no-widening invariant holds trivially.

### The filters and masks in use today — wave 2/4's work order

Four manifest scopes carry a `rowFilter` or a `fieldMask`, not the five the issue estimated; the fifth in the issue's count is the second constraint on one of these scopes (`locker core.entity_revision` carries both a filter and a mask). Pinned in `app-entity-tripwire.filters.json`:

| app | scope | verbs | rowFilter | fieldMask |
| --- | --- | --- | --- | --- |
| locker | `core.entity_revision` | read | `entity_type eq "locker.item"` | `revision_id, entity_type, entity_id, operation, snapshot_json, recorded_at, undo_until, undone_at` |
| locker | `access.receipt` | read | `object_type in ["locker.item", "locker.auth"]` | — |
| people | `core.entity_revision` | read | `entity_type eq "people.person"` | same eight columns |
| tally | `core.entity_revision` | read | `entity_type eq "tally.expense"` | same eight columns |

Counted exactly: locker ×2, people ×1, tally ×1. Every one is an app reading its own undo history or its own receipts, which is what the issue's re-judgement of #873 L-access says. Each must become a `WHERE` clause (and a column list) inside the owning query before wave 4 stops the evaluator applying it. `packages/blueprints/apps/locker/queries/access.ts` is the one to watch: its header says in the code's own words "THE ROW FILTER IS THE BOUNDARY … app.json's rowFilter on `object_type` is all that holds this grant to Locker's own receipts", so deleting the evaluator without moving that clause first widens what Locker's history pane returns. **Not re-expressed here** — that is waves 2 and 4, and doing it in this slice would remove the evidence the tripwire exists to preserve.

### Decisions

1. **Two precise call-site forms, not bare literals.** The scan matches `entity: "<schema>.<table>"` and `command: "<schema>.<verb>"`, reusing the parsing approach `app-manifest-reads.test.ts` and `scope-kit.test.ts` already use rather than writing a second parser. A bare-literal scan was prototyped and rejected: it cannot tell a reference from a filter *value*. `object_type: "locker.auth"` in `locker/queries/access.ts` names a column value in a WHERE clause — `locker.auth` is not an entity at all — and `locker.counts` / `locker.totp_code` / `locker.watchtower` are commands a bare scan reports as undeclared *reads*. A gate that cries wolf gets weakened; this one does not.
2. **Blind spots are registered, and the register is swept both ways.** A text scanner has two. (a) *Import depth*: resolution follows one hop of relative imports from each entry file, which is what reaches `_shared` kits and an app's own sibling tables, and it is bounded to the blueprint apps tree and the app's own mobile directory — without that bound, `apps/mobile/src/lib/replica/multi-vault-reader.ts`, a shell-wide registry naming every app's entities, charges `core.document` and `locker.item` to Photos. (b) *Indirection*: ten files reach a read through a variable — `entity: sidecar.entity`, the object shorthands `{ entity }` and `{ entity, limit }`, and `rowsOf(ctx, "locker.item_alias", …)`. Each is named in `INDIRECT_ENTITY_READS` with the entities it reaches, and those are checked against the manifest exactly like a literal. **The register is read in both directions** (`registerDrift`): every entity-shaped literal a registered file names must appear in its entry, so a literal added to the file and not to the list fails the build. A consumer that holds no literal of its own — `notes/queries/link-targets.ts`, `NotesPowerbox.tsx` — inherits the link-target table through `via` rather than transcribing it, so extending the table extends its consumers in the same edit. `unregisteredIndirection` fails when a *new* indirect file appears. The register therefore describes the files it names rather than excusing them; see `#### Fix after audit` for the one-directional version this replaced, which the audit reproduced as a hiding surface.
3. **`tests/claims.json` carries the law and the flow, not a `demonstratedRed` date.** `demonstratedRed` is a field of the 45 curated `claims` rows, each with a severity, lane, knob and wall-clock cost; a `laws`/`flows` registration — which is how `one-computation.test.ts` is registered, and the registration this slice was asked to mirror — has no such slot. Inventing a 46th claim row for a build-time text scanner would be a governance decision above this slice. The demonstrated-red date and its two commands are recorded in `## Verification` above instead.
4. **Both tests stay.** `app-manifest-reads.test.ts` is not superseded: it enforces the twice-declared `READS` matrix and the "declares no read nothing reaches for" direction, which this slice does not. Nothing was deleted, because nothing here replaces anything.

### Numbers

Provenance: host 4 cores / 15 GB, Node 22, worktree `claude/928-w1b-static-tripwire` at `origin/main` = `cf616a09`.

| measure | value |
| --- | --- |
| bundled apps scanned | 8 |
| manifest scopes read | 230 |
| distinct entity references resolved and checked | 110 |
| distinct command references resolved and checked | 134 |
| undeclared references found | 0 |
| `rowFilter` / `fieldMask` scopes enumerated | 4 (5 constraints) |
| files whose entity travels through a variable, registered and swept both ways, no exemptions | 10 (5 before the audit fix; the broadened shorthand match found 5 more) |
| tripwire wall clock, alone | 527 ms (18 tests) |
| runtime cost added | none — build-time only |

### Verification

```
bun run --cwd packages/blueprints test -- app-entity-tripwire   # 18 passed, 527ms
bun run --cwd packages/blueprints test                          # 207 files, 6597 passed | 2 expected fail
bun run --cwd packages/blueprints typecheck                     # clean
bun run --cwd apps/mobile typecheck                             # clean
bun run format && bun run lint                                  # clean
bun run test:claims                                             # 45 claims, 48 lanes, 193 derived flows
bun run check:push
```

#### Fix after audit

Both audit findings were reproduced first, then fixed in `app-entity-tripwire.{ts,test.ts}`; the audit text above is left as written.

1. **The register was a hiding surface.** It is now swept BOTH ways. `registerDrift` sweeps every entity-shaped literal in each registered file — restricted to the schema bands the manifests themselves declare, so `logins.csv` and `notes.md` are not entities — and fails when one is absent from that file's entry. Hand transcription is gone for the two consumers that hold no literal of their own: `notes/queries/link-targets.ts` and `NotesPowerbox.tsx` now carry `via: "…/link-targets-table.ts"` and inherit its set, so a kind added to the table reaches its consumers in the same edit. The audit's own reproduction — a `locker.item` link-target kind in `notes/link-targets-table.ts` — now fails with `link-targets-table.ts names "locker.item" but INDIRECT_ENTITY_READS does not list it`, and is kept as a test.
2. **Object shorthand was invisible.** `ENTITY_INDIRECT` now matches `[{,]\s*entity\s*[,}]` as well as `entity: <variable>`, so all three shapes register. This immediately found **five more indirect files the old regex was blind to** — `apps/mobile/src/apps/{agenda/useAgenda,docs/useDocs,photos/timeline-engine,tasks/useTasks}.ts` and `apps/_shared/pending-overlay.ts` — which are now registered with the literal sets swept out of them (all already declared; no manifest changed, so no widening). The register grows 5 → 10. That the fix immediately surfaced five real files is the measure of what finding 2 was hiding.

Also fixed in passing: `findUndeclared`'s dedupe key held **three raw NUL bytes** in a template literal, which made git treat `app-entity-tripwire.ts` as binary — the exact trap #916's audit hit, where a NUL let roughly a kilobyte of a change set escape textual review. The key is `JSON.stringify` of the tuple now, and the file reads as text.

Test count 13 → 17. New tests: the two-directional sweep on the real tree, `via` inheritance parity, and one seeded-red per audit finding.

#### Fix after re-audit

The re-audit found the same kind of hole one file further along, inside the fix: `registerDrift` skipped `via` entries, so removing the exemption at the TABLE rebuilt it at the CONSUMER. Reproduced on the real tree before fixing — `const EXTRA_TARGET = "locker.item";` plus `ctx.vault.search({ entity: EXTRA_TARGET, … })` in `packages/blueprints/apps/notes/queries/link-targets.ts` left the suite at 17 passed, with `locker.item` reaching Notes, which declares no `locker.*` scope.

`registerDrift` now sweeps EVERY registered file, `via` consumers included, each against the set it actually reaches (`reachedEntities`). An inherited set is still the set that file is answerable for; skipping it only moves the hiding place. The same reproduction now fails with `link-targets.ts names "locker.item" but INDIRECT_ENTITY_READS does not list it`, and is kept as a seeded-red test alongside a positive case proving a legitimately inherited entity still passes. The tree stays green: `literalsIn` over both `via` consumers is `[]` today.

Found and closed in the same pass, before a third audit could: `reachedEntities` answered `[]` for a `via` that names an unregistered file or another `via`, and an empty set checks nothing against the manifest and trips no sweep — the same hiding place in a third disguise. `registerIntegrity` makes an unresolved pointer a build failure; breaking one reports `link-targets.ts points at unregistered "…"`.

The lesson this slice keeps re-learning is worth stating plainly rather than as a decision: **every exemption in this register is a hiding place, and each fix that spares one case re-opens the hole at the case it spared.** The sweep now has no exemptions — `unregisteredIndirection` covers files not in the register, and `registerDrift` covers every file in it, whichever form its entry takes.

Test count 17 → 18, and the `blueprint-app-entity-tripwire-law` floor rises 13 → 17 with it (a new floor that only goes up; `tests/floors.json` mirrored, the classification-ratchet note extended and quoted in `## Decisions`).

#### Fix after third pass

`ENTITY_INDIRECT` did not match a backtick after `entity:`, so a file building its key as a template (`` entity: `${SCHEMA}.item` ``) was neither scanned nor reported unregistered — the fourth shape, and the last hiding place of this kind.

It now counts a template literal as indirection, interpolated or not, so such a file MUST be registered; the seeded case asserts a new unregistered file with a template-built key comes back from `unregisteredIndirection`, and the module header names four shapes rather than three. Zero instances in the tree today, so nothing moved but the guard.

### Approved deviation — `tests/quality/classification-ratchet.json`

Registering the tripwire's law and flow edits `tests/claims.json`, whose whole-file hash is a governed fingerprint. Re-pinning it is the documented mechanism (`node scripts/check-quality-knobs.mjs` names it), and the note below extends the existing section (last written by #930) rather than replacing it, per #781. **Nothing is loosened:** the change ADDS a law and a flow, and adds a new `minimumTests` floor of 17 — a tightening — and leaves the 45 governed claim rows byte-identical, so `claimsGovernanceFingerprint` does not move. The extended note, verbatim as it stands in the file:

> #930 re-pins the tests/claims.json whole-file fingerprint after removing the spent rename marker on the `golden-vault-archaeology` flow, superseding the #916 re-pin note rather than contradicting it — every sentence of #916's account of what that flow took over is kept, in receipts/issue-916-vault-ontology-review.md and in the flow's own `_comment`. `replacesMinimumTestsFlow` is a ONE-SHOT claim about the change set that makes a rename, checked against the merge base; once #916 landed, `schema-migration-corpus` existed at no base any more, so the marker could only ever report an unknown predecessor and `lint:ledgers` / `test:ratchet` were red on main itself. The marker and the `approvedMinimumTestsDeviation` that authorized it are removed together, because that note waives a future minimumTests drop on this flow by presence alone; the floor stays at 5, no claim row, severity, evidence selector or demonstrated-red date moves, and claimsGovernanceFingerprint is unchanged. Prior: #916. #928 w1b re-pins tests/claims.json once more, for the static app entity tripwire: it registers the new law `app-entity-tripwire` and its flow `blueprint-app-entity-tripwire-law` (owner packages/blueprints/src/app-entity-tripwire.test.ts, minimumTests 17), mirroring how `one-computation` is registered so the lane is owned. Additions to the law and flow registries only, and a NEW minimumTests floor, which is a tightening — no claim row, severity, evidence selector, demonstrated-red date or existing floor moves, and the 45 claim rows stay byte-identical, so claimsGovernanceFingerprint is unchanged. Prior: #930.

### Verification — commands and the seeded reds

```
bun run format                                          # 5354 files
bun run lint                                            # clean
bun run --cwd packages/blueprints test                  # 207 files, 6597 passed | 2 expected fail
bun run --cwd packages/blueprints typecheck             # clean (tsconfig.test.json + tsconfig.apps.json)
bun run --cwd apps/mobile typecheck                     # clean
bun run test:claims                                     # 45 claims, 48 lanes, 193 derived flows
bun run check:push                                      # see below

# the tripwire alone
bun run --cwd packages/blueprints test -- app-entity-tripwire
#   Test Files  1 passed (1)
#   Tests  18 passed (18)   Duration 527ms
```

**Seeded red, demonstrated 2026-09-03 against the real tree**, both halves, each restored immediately after:

```
# READ half — drop `schedule.project` from apps/tasks/app.json#vault.scopes
bun run --cwd packages/blueprints test -- app-entity-tripwire
#  × no app reads or invokes anything its manifest does not declare
#  + "tasks: read \"schedule.project\" in packages/blueprints/apps/tasks/queries/board.ts
#     is not in app.json#vault.scopes"

# ACT half — drop `locker.purge_item` from apps/locker/app.json#vault.scopes
bun run --cwd packages/blueprints test -- app-entity-tripwire
#  + "locker: act \"locker.purge_item\" in packages/blueprints/apps/locker/actions/purge-item.ts
#     is not in app.json#vault.scopes"
```

The failure names the app, the file and the entity, which is the acceptance criterion. Four further seeded violations run on every build from synthetic manifests inside the test (`describe("seeded violations")`): an undeclared read, an undeclared command, a read verb that must not pay for a command or a command for a read, and a read named for a scope no app declares being charged to the app that wrote it rather than vanishing.

No `app.json` changed, so the `manifest-scope-denial.*` sweeps in `packages/server/src/serve/` are untouched by this slice and the `handler-contract` / `declared-writes` directive has nothing new to judge.

### Audit

The three verifier verdicts, verbatim as written, newest first.

### 1(b) — the static app tripwire

Verdict: PASS — third-pass verification of `8078afd8` (`#### Fix after re-audit`). All three reproduced hiding surfaces are closed, each re-reproduced as closed against this head, and no exemption is left in the register. The two earlier verdicts below are kept as written; the sections they judged are byte-identical to what I audited (`## Audit` hashes the same at `045a1de7` and `8078afd8`).

Closed, re-reproduced against `8078afd8`:

- The re-audit finding (a `via` consumer excused by `registerDrift`): `const EXTRA_TARGET = "locker.item";` plus a `ctx.vault.search({ entity: EXTRA_TARGET, … })` probe in `packages/blueprints/apps/notes/queries/link-targets.ts` now fails — `packages/blueprints/apps/notes/queries/link-targets.ts names "locker.item" but INDIRECT_ENTITY_READS does not list it` — naming file and entity. Suite 18, one red.
- `registerIntegrity` (`app-entity-tripwire.ts:320-338`), the worker's own third fix, holds on both shapes I attacked. Repointing `link-targets.ts`'s `via` at a non-existent path fails with `… points at unregistered "packages/blueprints/apps/notes/does-not-exist.ts"`; repointing it at `NotesPowerbox.tsx`, itself a `via`, fails with `… points at "apps/mobile/src/apps/notes/NotesPowerbox.tsx", itself a via`. Both would otherwise have made `reachedEntities` answer `[]` — "reaches nothing", which checks nothing and trips no sweep — so this closes the disguise before it was used.

My own disguise, and the one gap it found:

- A **template-built entity key** is seen by neither half. A new, unregistered `packages/blueprints/apps/tasks/queries/probe-template.ts` whose read passes `entity` a template literal (backtick, `${SCHEMA}.item`) rather than a quoted string leaves the suite at **18 passed**: `ENTITY_LITERAL` wants a double quote, and `ENTITY_INDIRECT`'s `entity:\s*(?!")[A-Za-z_$][\w$.]*` does not match a backtick, so the file is not scanned *and* not reported unregistered. This is narrower than the three findings above — it is a parse gap, not a hiding place the register manufactures — and it is **latent, not live**: a `grep -rnE` for an `entity:` key followed by a backtick over `packages/blueprints/apps` and `apps/mobile/src/apps` returns nothing, and the only such keys in the repo are `ext.<app>.<table>` in `packages/vault/src/gateway/ext*.test.ts`, outside this scanner's surface. It is not a stated limit either — the module header's indirection bullet claims that class is closed and that `unregisteredIndirection` fails when a new such file appears, which is not true of this shape. Not a blocker for box 3, which is realized and proven; worth one line before the header's claim is relied on by a later wave: allow a backtick after `entity:` in `ENTITY_INDIRECT` (so the file must be registered), or name the shape in the header as a third deliberate limit.
- The other disguise the root suggested, a constant re-exported from `_shared` at depth 2, **is** a stated limit ("ONE LEVEL OF IMPORTS … A literal two hops out is not seen"). I re-enumerated the depth-2+ reachable set: `apps/_shared/format-kit.ts`, `apps/notes/filing.ts`, `apps/notes/types.ts` — none references an entity or a command, so the stated limit costs nothing today.

Confirmations requested:

- **No `app.json` changed in any commit**: `git log --name-only origin/main..HEAD | grep -c 'app\.json$'` → `0`. Nothing widened at any point across the five commits.
- **Floor rises only**: `blueprint-app-entity-tripwire-law` 13 → 17 in `tests/claims.json`, mirrored to 17 in `tests/floors.json`; re-running `node scripts/check-ledgers.mjs --write` leaves `tests/floors.json` untouched, so the mirror is refreshed. Neither `lint:ledgers` nor `test:ratchet` names the flow — their only complaint is the pre-existing `schema-migration-corpus` predecessor. (The suite now carries 18 tests against a floor of 17; a floor is a minimum, so this is correct, merely one short of exact.)
- **Claims payload**: the 45 `claims` rows remain byte-identical to `origin/main` (parsed and compared); only `laws` and `flows` differ, both additions.
- **Deviation note quoted verbatim**: compared the receipt's blockquote in `## Decisions` against `tests/quality/classification-ratchet.json#approvedDeviation` character-for-character — identical, including the new 13 → 17 sentence.
- `node scripts/check-quality-knobs.mjs` → "quality knob governance: no silent widening".
- **Prior audit blocks intact**: the `## Audit` section hashes `024876d6…` at both `045a1de7` and `8078afd8` — nothing in either earlier verdict was rewritten.
- **Binary trap clean**: `file` → "JavaScript source, Unicode text, UTF-8 text"; `git diff --numstat origin/main -- packages/blueprints/src/app-entity-tripwire.ts` → `510 0`.

Gates run on `8078afd8`: `bun run format` (5354 files, `git diff --stat` empty after); root `bun run lint` clean; `bun run --cwd packages/blueprints test` → 207 files, 6602 passed | 2 expected fail; `bun run --cwd packages/blueprints typecheck` clean; `bun run test:claims` → 45 claims, 48 lanes, 193 derived flows; `bun run lint:law-registry` → 49 laws, 83 tag sites; `bun run --cwd packages/server test -- manifest-scope-denial` → 4 files, 99 passed | 3 expected fail; `node scripts/check-quality-knobs.mjs` clean; `bash .governance/run.sh` → 21 passed, `repo-hygiene` (`locker/queries.test.ts`, 638 lines) the only red and pre-existing on `origin/main`; `bun run lint:ledgers` / `bun run test:ratchet` red only on the pre-existing "unknown predecessor schema-migration-corpus". Every throwaway edit reverted; `git status` clean apart from this receipt.

#### Second pass — audit of `ddb6a27d`

Verdict: REFUTED — re-verification of `ddb6a27d` (`#### Fix after audit`). Both first-pass findings are genuinely closed; a third, of the same kind, is open in the fix itself.

Re-verification finding:

- `packages/blueprints/src/app-entity-tripwire.ts:362-380` (`registerDrift`; the `"via" in entry → continue` at :368), against `### Decisions` item 2 "the register therefore describes the files it names rather than excusing them" and `#### Fix after audit` item 1 → **a `via` consumer is still excused, not described.** The sweep runs only over entries carrying `entities`, so the two `via` files are exempt from it — the exemption the fix removed at the table, re-created at its consumers. Reproduced on the real tree: adding `const EXTRA_TARGET = "locker.item";` and a `ctx.vault.search({ entity: EXTRA_TARGET, … })` probe to `packages/blueprints/apps/notes/queries/link-targets.ts` (a `via` consumer; Notes declares no `locker.*` scope) leaves `bun run --cwd packages/blueprints test -- app-entity-tripwire` at **17 passed**. Nothing sees it: the literal is not in `entity: "…"` position so `ENTITY_LITERAL` misses it, the file is registered so `unregisteredIndirection` is silent, and `registerDrift` skips it for being `via`. That file reads its entities through variables today, so a const-borne probe is the idiomatic way to add one there. Fix: in `registerDrift`, sweep a `via` entry's literals against `reachedEntities(file.path)` instead of skipping — measured `literalsIn` over both `via` consumers with the real schema bands and both return `[]`, so the check is green as the tree stands and costs nothing.

What the fix closed, re-reproduced against `ddb6a27d`:

- First-pass finding 1 (the table half): the `LOCKER_TARGET_ENTITY = "locker.item"` kind in `notes/link-targets-table.ts` now fails — `packages/blueprints/apps/notes/link-targets-table.ts names "locker.item" but INDIRECT_ENTITY_READS does not list it` — naming file and entity.
- First-pass finding 2: a new unregistered `packages/blueprints/apps/tasks/queries/probe-shorthand.ts` holding same-line `ctx.vault.read({ entity })` now fails, naming the file; on the shipped module `hasIndirectEntity` returns `true` for both `{ entity }` and `{ entity, limit: 5 }`.
- Register 5 → 10 with no manifest change: `git diff --name-only origin/main...HEAD` lists no `app.json`. Checked all four new non-empty entries against their own manifests independently — agenda, docs, photos and tasks each declare every entity registered for them (agenda's `schedule.*` and photos' `media.*` through a schema band, which is the manifest's own granularity); `_shared/pending-overlay.ts` registers `entities: []`.
- `packages/blueprints/src/app-entity-tripwire.ts` is now plain text: `file` → "JavaScript source, Unicode text, UTF-8 text", and `git diff --numstat origin/main -- …` → `480 0`, not `- -`. The NUL bytes were present in `0107daf7` and the first pass did not catch them.

Non-blocking observation: the registered floor `blueprint-app-entity-tripwire-law: 13` now sits below the 17 tests the file carries. A floor is a minimum so nothing is red, but re-pinning it to 17 keeps the ratchet doing its job.

Gates re-run on `ddb6a27d`: `bun run format` (5354 files, `git diff --stat` empty after); root `bun run lint` clean; `bun run --cwd packages/blueprints test` → 207 files, 6601 passed | 2 expected fail; `bun run --cwd packages/blueprints typecheck` clean; `bun run test:claims` → 45 claims, 48 lanes, 193 derived flows; `bun run lint:law-registry` → 49 laws, 83 tag sites; `bun run --cwd packages/server test -- manifest-scope-denial` → 4 files, 99 passed | 3 expected fail; `node scripts/check-quality-knobs.mjs` → no silent widening; `bash .governance/run.sh` → 21 passed, `repo-hygiene` (`locker/queries.test.ts`, 638 lines) the only red and pre-existing on `origin/main`; `bun run lint:ledgers` / `bun run test:ratchet` red only on the pre-existing "unknown predecessor schema-migration-corpus". Every throwaway edit reverted; `git status` clean apart from this receipt.

#### First pass — audit of `0107daf7`

Verdict: REFUTED

Findings:

- `packages/blueprints/src/app-entity-tripwire.ts:32-37, 179-226` and receipt `## 1b … ### Decisions` item 2 → the register **is** a hiding surface for the files already in it, contrary to "the scanner cannot go blind without someone saying so in a diff". A registered file's entity list is hand-kept and one-directional: each listed entity is checked against the manifest, but nothing checks that the file still reaches only those. Reproduced against the real tree: adding `export const LOCKER_TARGET_ENTITY = "locker.item";` and a `{ appId: "locker", entity: LOCKER_TARGET_ENTITY, … }` kind to `packages/blueprints/apps/notes/link-targets-table.ts` (Notes declares no `locker.*` scope) leaves `bun run --cwd packages/blueprints test -- app-entity-tripwire` at **13 passed** — the constant carries no `entity: "…"` literal, so `ENTITY_LITERAL` misses it, and the file is already in `INDIRECT_ENTITY_READS`, so `unregisteredIndirection` stays silent. This is the exact shape `NOTE_TARGET_ENTITY` already has in that file, so it is the natural way to add a kind, not a contrived one. `packages/blueprints/apps/notes/queries/link-targets.ts` and `apps/mobile/src/apps/notes/NotesPowerbox.tsx` contain no qualified literal at all — their seven-entity registrations rest entirely on the register. Fix: sweep every bare `"<schema>.<table>"` string literal in the five registered files and fail when one is absent from that file's `INDIRECT_ENTITY_READS` list (all literals in those files today are real, declared entities, so the sweep is green as it stands), or re-derive the list from the constant table instead of transcribing it.
- `packages/blueprints/src/app-entity-tripwire.ts:162-171` → `ENTITY_INDIRECT` misses object shorthand unless it sits alone on its own line with a trailing comma. Measured on the shipped module: `hasIndirectEntity("ctx.vault.read({ entity });")` → `false`; `hasIndirectEntity("ctx.vault.read({ entity, limit: 5 });")` → `false`; only `read({\n  entity,\n});` → `true`. A **new** file of that shape is therefore neither scanned nor reported as unregistered, which is the failure mode `unregisteredIndirection` exists to prevent. Fix: match `entity` in shorthand position generally (`[{,]\s*entity\s*[,}]`) rather than anchoring to a whole line.

What was verified and holds (recorded so the re-do does not re-litigate it):

- Diff ↔ receipt: all 7 files in `git diff origin/main...HEAD --stat` are named in `## What changed`; nothing described that is not there. No `app.json` edited (confirmed by the diff), so the no-widening claim holds trivially.
- `## Checklist` mirrors #928's twelve acceptance criteria verbatim and in order, with only box 3 ticked.
- Pre-approved extras confirmed: `tests/claims.json`'s 45 `claims` rows are byte-identical to `origin/main` (parsed and compared; only `laws` and `flows` differ, both additions); `tests/floors.json` adds one line (`blueprint-app-entity-tripwire-law: 13`) and lowers nothing; the extended `approvedDeviation` is quoted in `## Decisions`. `node scripts/check-quality-knobs.mjs` → "no silent widening".
- Filters fixture matches the manifests exactly: `grep -n 'rowFilter\|fieldMask' packages/blueprints/apps/*/app.json` returns 7 hits over 4 scopes (locker `core.entity_revision` filter+mask, locker `access.receipt` filter, people and tally `core.entity_revision` filter+mask), byte-matching `app-entity-tripwire.filters.json`.
- Box 3's clauses are realized for the literal half: seeded reds against the real tree fail naming app, file and entity — an undeclared read from `apps/tasks/queries/board.ts` ("tasks: read \"locker.item\" …"), from the phone (`apps/mobile/src/apps/tasks/useTasks.ts`, "tasks: read \"locker.item_field\" …"), and an undeclared **command** from `apps/tasks/actions/add-tag.ts` ("tasks: act \"locker.purge_item\" …"). All three throwaway edits reverted; `git status` clean.
- One-hop bound: stated in the module header and in the test's `oneHopImports` doc. Enumerated depth-2+ reachable files myself — only `apps/_shared/format-kit.ts`, `apps/notes/filing.ts`, `apps/notes/types.ts`; none contains an `entity:` or `command:` reference, so nothing an app uses today falls outside the bound.

Gates run: `bun run format` (5354 files, `git diff --stat` empty after); root `bun run lint` clean; `bun run --cwd packages/blueprints test` → 207 files, 6597 passed | 2 expected fail; `bun run --cwd packages/blueprints typecheck` clean; `bun run test:claims` → 45 claims, 48 lanes, 193 derived flows; `bun run lint:law-registry` → 49 laws, 83 tag sites; `bun run --cwd packages/server test -- manifest-scope-denial` → 4 files, 99 passed | 3 expected fail; `bash .governance/run.sh` → 20 passed, `repo-hygiene` (`locker/queries.test.ts` 638 lines) and `receipt-per-issue` (this section) the only reds, the first pre-existing on `origin/main`; `bun run lint:ledgers` / `bun run test:ratchet` red only on the pre-existing "unknown predecessor schema-migration-corpus" — neither names the new floor.

## w1c — the automation principal kind in the schema

Execution-plan wave 1(c). The one authority plane **accepts** an automation answer; nothing writes one. Wave 3 is its writer, and the point of accepting it a wave early is that wave 3 lands without touching the schema, the registry, the CHECK vocabulary or either dashboard. **Nothing is ticked above** — accepting a value in a CHECK is not, on its own, any of #928's acceptance criteria.

### What changed

- **`packages/vault/src/schema/authority.ts`** — `automation` added to the `principal_kind` CHECK, with the comment naming its writer (`#928 wave 3 writes it`) so a value with no producer is not mistaken for a dormant mechanism, and naming why `app` is absent (first-party apps are not principals, #928 A1; a third-party door would be a new answer, not a new value). `automation` joins `NON_ENTITY_PRINCIPAL_KINDS`, not `PRINCIPAL_ENTITY_KINDS`: **an automation is not a vault entity**. Its canonical id is the manifest ref `<app_id>/<automation_id>` minted by `packages/server/src/automation/manifest/ref.ts`; the only thing keyed by it in the vault is `automation_state` / `automation_trigger_cursor` in the ledger band, keyed by that text with no foreign key, and there is no `agent`-plane or `gateway.db` row for an automation at all. So it carries the same reasoning `harness` and `device` carry — no `core_entity` row to purge — and the generated `core_entity_revoke_on_purge` clause in `schema/entity.ts` is deliberately unchanged, because there is no purge event to answer for.
- The `granted_by` CHECK (`granted_by IS NOT NULL OR principal_kind IN ('harness','device')`) is **not** widened: the owner approves an automation's manifest, so a party always answered, and a row minted without one would be an automation that granted itself. The reason is written beside the CHECK.
- **`packages/vault/src/grant/authority-registry.ts`** — `AuthorityPrincipalKind` gains `automation` (and `app` is documented as a type-level absence, never a triple that refuses); `AuthorityStrategy` gains `execution-clamp`; `enforcementLocus("automation")` is `local`, on the same argument as `harness` — an automation runs inside this vault's own engine, so the only thing that ever called it is the thing that stops calling it. Two triples are added, both `read`+`act`, both fulfilled by `execution-clamp`, both cited `#928 A3 over #883 V-registry`:
  - `automation × agent.pack` — a whole command pack, `subject_id` being the pack/schema name, which is what a manifest scope with a `schema` and no `table` asks for;
  - `automation × core.entity` — one entity type, `subject_id` being the dotted entity type, which is what a manifest scope with `schema` + `table` asks for.

  An automation is answered about a **class** of rows, never one row, which is why the subject id is a type name rather than an entity id. `reveal` is absent by type: a sealed reveal is Locker's permit, not a standing grant (#873, and #750 for the same reason `locker.item` has no share triple). **No `app` triple is added.**
- **`packages/vault/src/schema/ontology-shape.test.ts`** — the CHECK-vocabulary test (`accounts for every principal kind the table admits`) needed no edit: it derives the expected set from `PRINCIPAL_ENTITY_KINDS` + `NON_ENTITY_PRINCIPAL_KINDS`, so adding the kind to the map is what keeps the trigger's vocabulary and the table's from drifting. A new case inserts an `automation` answer (principal id `photos/dedupe`, subject `agent.pack media`, granted by the owner) and proves an `app` row and a `granted_by`-less automation row are both still refused by CHECK.
- **`packages/vault/src/grant/authority-registry.test.ts`** — the automation triples enumerated verb by verb; `reveal` and `view` refused; `media.asset` carries no automation triple; `app` carries no triple at all for any subject type; `enforcementLocus("automation") === "local"`.
- **`packages/vault/tests/golden/issue-916/manifest.json`** and **`packages/vault/tests/golden/issue-916/vault.db.gz`** — the golden corpus re-frozen under the same label, per the ONT-ladder ruling below, with the old corpus proven sound first.
- **`docs/vault-ontology.md`** — R6's standing now states the plane's principal kinds, marks `automation` "accepted in #928 wave 1, written in wave 3", says what its id and subjects are, and says `app` is not among them and is not reserved as a value. The commitments table gains the **ONT-ladder** row: pre-1.0 with no release since the freeze, a baseline DDL change re-freezes the corpus in the same slice with the old corpus proven to open; the first change after a release adds a rung instead.

**No new member copy was written.** `grant/phrases.ts` holds no principal-noun table to extend, and the per-locus revoke sentence an automation needs already exists and already reads correctly for it: `revokePromiseCopy("local")` is *"nothing here will call it again — this vault is the only thing that ever did"*. Adding an unused automation phrase would have been a promise with no producer, which is what #916 ONT-06 deleted four of.

### Out of scope

Wave 1c writes **no** automation row and deletes nothing. The **Access dashboard** is out of scope for this wave by decision (below), so `packages/client/src/access-lens.ts` and `packages/client/src/access-lens.test.ts` are unchanged. Also explicitly untouched: every prospective writer (`serve/vault-plane.ts`, `lifecycle/headless-automation-compile.ts` — wave 3), the migration script, `evaluateAccess` and everything under `access_*`, the assistant's standing grant, `grant_profile_json`, `outbox_grant`, and any `app`-kind triple. `docs/glossary.md` is w1a's and is untouched here. `packages/core/src/protocol/**` and `docs/protocol.md` are untouched because `principal_kind` is not on the wire as a typed union — the Access dashboard reads the authority rows out of the device replica, and the server's own SQL narrows to `principal_kind IN ('person','circle')` at every site (`serve/grant-fulfillment.ts`, `routes/edges-reconcile.ts`), so nothing there widens or breaks. `scripts/docs-site/src/content/ontology-body.html` is untouched because `ontology-doc.test.ts` compares column tuples (name, type, flags, references) and a widened CHECK adds no column and changes no flag.

### Nothing deleted

This slice is additive by design: a value with no writer, two registry triples, two tests, one doc row. No store, engine, rig or ruling is superseded by it, so there is nothing to delete beside a replacement.

### The golden corpus: the OLD corpus proven sound, then re-frozen

The widened CHECK made the frozen `share_authority` DDL text differ from a freshly founded vault's — no rung rewrites a table it did not name, and #916 ruled one baseline rung. **Before re-freezing, the evidence that matters was captured on the OLD, unmodified corpus:**

```
$ bun run --cwd packages/vault test -- --run src/golden-vault.test.ts --reporter=verbose
 ✓ golden vaults > has at least one frozen corpus to open
 ✓ golden vaults > issue-916 > opens under today's code and migrates forward
 ✓ golden vaults > issue-916 > preserves every row the release froze
 × golden vaults > issue-916 > carries the schema today's baseline builds
   → table share_authority: frozen DDL differs from the baseline's
 ✓ golden vaults > issue-916 > holds together structurally after migrating
 Tests  1 failed | 4 passed (5)
```

So the pre-1.0 file **opens**, **migrates forward**, **preserves every frozen row** and is **doctor-clean**; only the DDL-equality case is red, which is the case the re-freeze exists for. After `bun run golden-vault:freeze -- --label issue-916` the same command is `5 passed (5)`, and the full package suite is green.

The corpus diff against `origin/main` is `manifest.json` (115 insertions, 115 deletions) and `vault.db.gz` (125128 → 125125 bytes). **It is not only the DDL text, and that is a finding about the freeze script, not about this change** — see the decisions below. Structurally the corpus is unchanged, compared field by field against main's manifest: the same 67 tables, the same 288 rows, identical per-table row counts, identical primary keys, and 53 of the 67 tables digest-identical. The 14 that differ are the ones whose ids are minted by `uuidv7()` through the vault's own commands rather than by the script's seeded generator, so their ids — and every digest taken over them — move with the wall clock.

### Decisions

- **`automation` is a non-entity principal kind.** Established by reading, not assumed: there is no automation table in the vault's `agent` plane, none in `gateway.db`, and the only automation-keyed rows (`automation_state`, `automation_trigger_cursor`) key on the manifest ref as free text. So the revoke-on-purge trigger is deliberately left alone.
- **Two subject types, `agent.pack` and `core.entity`.** #928's Decision A3 says an automation's answers are minted "per (pack or entity × read|act)"; a manifest scope is `{schema, table?, verbs}`, so a scope with no table is a pack and a scope with one is an entity type. Spelled in the registry's existing dotted style (`core.vault`, `enrich.scope`), with the *type name* as `subject_id` because the answer is about a class of rows. **Accepted by the umbrella owner, with the note that wave 3 may rename either subject type before the first row is written** — nothing writes them yet, so the rename costs one edit; after wave 3's first row it costs a migration.
- **ONT-ladder — how a baseline DDL change is reconciled with the frozen corpus.** **Pre-1.0, with no release since the freeze**: change the baseline in place and **re-freeze the corpus in the same slice**, after proving the OLD corpus opens, migrates forward, keeps every row and is doctor-clean. **The first change after a release adds a rung instead**, because a corpus a release shipped is the only evidence a rung works, and regenerating it would erase the thing under test. The `issue-916` corpus is one day old and from the same pre-release tree, and `golden-vault.test.ts`'s own header already re-freezes for a retired column — a widened CHECK is the same class of DDL-text change. Ruled by the umbrella owner; recorded in `docs/vault-ontology.md`'s commitments table so the next slice does not re-litigate it.
- **The Access dashboard's automation group waits for the wave that writes the first row.** The lens change was written and then reverted, on two grounds that agree. (i) **Gate**: `check:ui-receipt` treats any `packages/client/**` edit as user-facing and requires `## User impact`, a `First-run:` note and a screenshot emitted by a *changed* e2e harness under `artifacts/e2e/ui-impact/`. No automation row can exist before wave 3, so no such screenshot can be taken; naming a path for a screenshot nobody produced would be fabricated evidence, and the alternative — loosening the gate — is forbidden. (ii) **Product**: with no writer, the only visible effect on either seat is an "Automations" card reading "No standing answers here." — a section advertising something that cannot yet exist. Nothing is at risk in the meantime: `parseAnswer` drops a kind it does not know *by design* ("a drifted row is DROPPED, never half-drawn"), and there is nothing to drop. **Wave 3 must carry it**, and it is cheap and self-evident there: `AccessPrincipalKind` + `PRINCIPAL_KINDS` + one `GROUPS` entry (`automations` / "Automations" / locus `local` — its own group, not folded in with harnesses: an automation is a thing the owner approved by name, a harness is an engine class). Both renderers already draw a group generically, so neither needs a code change. Deferral **accepted by the umbrella owner**.
- **No new phrase.** See "What changed" — the local revoke sentence already covers the kind, and `phrases.ts` has no principal-noun table to hold one.
- **A value with no writer is admitted only because #928 wave 3 is its writer.** #916's rule is that every CHECK admits only what is written; this is a one-wave exception taken deliberately, named in the CHECK's own comment and in the doc, so that the wave which widens the model does not also have to widen the schema. If wave 3 does not land, the value is a finding.
- **Finding: `scripts/golden-vault/build.mjs` is not deterministic, and its header says determinism "is the whole job".** Two consecutive freezes of the same label produce different corpora — verified directly by freezing twice in a row and diffing the manifests, which differ — because ids minted by `uuidv7()` inside the vault's own commands are clock-derived while only the script's own `seededIds` generator is seeded. The consequence is that a re-freeze cannot be reviewed as "only the DDL text moved"; the reviewer has to compare table sets, row counts and primary keys instead, as this section does above. Not fixed here — `scripts/` is outside this slice's contract, and the fix (thread the seeded generator through the command calls, or freeze a fixed clock) is a change to the freeze mechanism that deserves its own review. Filed for the umbrella owner.

### Verification

Host: 4 cores / 15 GB, this slice's own worktree. This section is **stacked on w1b**: the slice was verified first on `origin/main` at `e2f277da3` (which carries w1a, #930, #922's rulings and #927 w1-core), then rebased onto w1b's branch at `bf5a56b0f` to cut a CI round trip. Package suites are run **one at a time** — an earlier attempt ran the client and server suites concurrently and both were OOM-killed (`SIGKILL`), which is a host limit, not a result.

Re-run on the w1b-based tree, since w1b touches `packages/blueprints/src/app-entity-tripwire*`, `tests/claims.json`, `tests/floors.json` and `tests/quality/classification-ratchet.json` — none of which this slice touches, and the two slices' only shared file is this receipt:

```
bun run format                              # oxfmt, 5355 files, clean
bun run lint                                # oxlint --deny-warnings, clean
bun run --cwd packages/vault typecheck      # clean
bun run --cwd packages/vault build          # clean
bun run --cwd packages/vault test           # 200 files, 1572 passed, 2 skipped, 0 failed
bun run --cwd packages/blueprints typecheck # clean (w1b's tripwire reads the schema this slice widens)
bash .governance/run.sh                     # 22 directives, all green
```

Run once on the `e2f277da3` tree and unaffected by w1b's four files:

```
bun run --cwd packages/server test -- --run \
  src/serve/authz-deny-matrix.test.ts src/serve/authz-matrix.smoke.test.ts   # 2 files, 88 passed
bun run lint:product                        # 39/39 product gates
bun run --cwd packages/client typecheck     # clean
bun run --cwd apps/mobile typecheck         # clean
```

The evidence the golden-corpus ruling rests on, captured before the re-freeze on the original tree:

```
bun run --cwd packages/vault test -- --run src/golden-vault.test.ts --reporter=verbose
                                        # BEFORE the re-freeze: 4 passed, 1 failed (the proof, below)
bun run golden-vault:freeze -- --label issue-916
                                        # froze issue-916 — 67 table(s), 288 row(s), schema v1 (ontology 1.0)
bun run --cwd packages/vault test -- --run src/golden-vault.test.ts --reporter=verbose
                                        # AFTER the re-freeze: 5 passed, 0 failed
```

The named invariant suites are green: the authz deny matrix and `authz-matrix.smoke`, plus `gateway/access-properties.test.ts`, `schema/ontology-rules.test.ts`, `schema/ontology-doc.test.ts`, `schema/lifecycle.test.ts` and `schema/entity-refs.test.ts` inside the green vault package suite.

Known reds NOT caused by this slice, each reproduced on an unmodified tree: `acp/backends/acp/launch.test.ts` fails twice because this container exports `IS_SANDBOX=yes` and the test asserts the value the launcher would set (`"1"` / `undefined`); `serve/gateway-db-lock.integration.test.ts` fails because the `sqlite3` CLI it shells out to is absent (a spawn failure, `status === null`); `test:qualities`'s `kill-mid-write.integration.test.ts` times out because the child gateway dies at `git commit … : unable to create temporary file`; `design:gallery` needs a Playwright chromium that is not installed here. No server file is touched by this slice.

### Audit

(verbatim from the fresh-context verifier, commit `a298263c`)

Fresh-context verifier, wave 1c (`e9787c7d`, 8 files, +344/−122). Merge base `cf616a09a`; `origin/main` has since advanced to `5823f098d`.

Verdict: PASS

- **Diff ↔ receipt.** All 8 files in `git diff origin/main...HEAD` are named and described in `## What changed`; nothing described is absent. No scope creep: nothing outside the slice contract — `grant/phrases.ts`, `packages/core/src/protocol/**`, `docs/protocol.md`, `ontology-body.html`, `packages/client/**` and `apps/mobile/**` are untouched by the diff, as claimed.
- **Checklist ↔ issue.** The 12 boxes are byte-identical to #928's acceptance criteria (diffed mechanically against the issue body); `grep -c '\- \[x\]'` is 0 — nothing ticked, correct for a slice that only accepts a value.
- **CHECK behaviour, verified independently** of the worker's tests, against `dist/schema/authority.js` in a throwaway in-memory DB: `automation` + `granted_by='owner'` ACCEPTED; `automation` + `granted_by NULL` REFUSED (`granted_by IS NOT NULL OR principal_kind IN ('harness','device')`) — the exemption is not widened; `app` REFUSED by the `principal_kind` CHECK; `device` + `granted_by NULL` still ACCEPTED — the harness/device exemption is intact.
- **`core_entity_revoke_on_purge` (schema/entity.ts:187).** The principal clause is generated from `PRINCIPAL_ENTITY_KINDS`, which is unchanged, so every entity-kind principal is still covered and `automation` is correctly skipped: `principal_kind = CASE OLD.entity_type … END` can only ever equal a mapped kind, and yields NULL (no match) for an unmapped type. Consistent with `automation` having no `core_entity` row.
- **No exhaustive-switch hazard.** `AuthorityPrincipalKind` / `AuthorityStrategy` have no consumer outside `authority-registry.ts` and the barrel; `enforcementLocus` is the only kind-dispatch and handles `automation`. `lociWire` (`server/src/routes/grant-routes.ts:132`) keys by locus, so the `local` revoke sentence an automation needs is already on the wire — the "no new phrase" claim holds.
- **Golden corpus, structural comparison against `origin/main`'s manifest** (ids are non-deterministic, #935): same 67 tables, same table set, 288 rows both sides, identical per-table `rows`, `columns` and `primaryKey` for all 67; only `digests` differ, in exactly 14 tables — the receipt's figures reproduce. The re-frozen `vault.db.gz` carries the widened CHECK (`'person','circle','harness','device','automation'`); main's carries the four-value one. `share_authority` gains no column. `golden-vault.test.ts` 5/5 inside the green package suite.
- **Doc.** R6 states `automation` as "accepted in #928 wave 1, written in wave 3"; the new ONT-ladder commitment row claims no written row. No sentence in `docs/vault-ontology.md` asserts an automation row exists today.
- **Doctrine.** Each "deliberate"/"by design" seam names a live property (no `core_entity` row to purge; first-party apps are not principals; a row minted without a granter would be self-granted authority). No budget, floor, allowlist or ratchet was widened; no test skipped, quarantined or deleted.

Gates run (this worktree, 4 cores):

- `bun run format` → clean, `git status --porcelain` empty after
- `bun run lint` → clean
- `bun run --cwd packages/vault build` → clean; `… typecheck` → clean
- `bun run --cwd packages/vault test` → 200 files, 1572 passed, 2 skipped, 0 failed (948 s) — includes `golden-vault`, `access-properties`, `ontology-rules`, `ontology-doc`, `lifecycle`, `entity-refs`, `ontology-shape`, `authority-registry`
- `bun run --cwd packages/server test -- --run src/serve/authz-deny-matrix.test.ts src/serve/authz-matrix.smoke.test.ts` → 2 files, 88 passed
- `bun run --cwd packages/client typecheck` → clean; `bun run --cwd apps/mobile typecheck` → clean
- `bash .governance/run.sh` → 20 passed, 2 failed: the attestation this section satisfies, and `repo-hygiene` on `packages/blueprints/apps/locker/queries.test.ts` (638 lines) — untouched by this diff and already split on `origin/main` by `0d7975254` (#930); it clears on rebase

Observation for the umbrella owner, not a defect of this slice:

- `packages/vault/src/grant/authority-registry.ts` reports as **binary** in `git diff --numstat` (`-\t-`), so its hunk is invisible to a normal textual review. Cause: two raw NUL bytes at offsets 7092 and 7288, used as the `BY_KEY` composite-key delimiter — **pre-existing, byte-identical on `origin/main`**, not introduced here. This slice's edit was reviewed against a NUL-stripped copy of both revisions and matches `## What changed` exactly. Fix (own slice): write the delimiter as the two-character escape `\\0` in source, or use a nested `Map`, rather than embedding a literal NUL byte.

## w1 root doc commit

The root's one doc commit for wave 1. It writes no code and adds no evidence of its own: it
ticks the acceptance boxes the wave's slices realized, and records where each tick's evidence
already lives.

### What changed, file by file

- **`receipts/issue-928-one-authority-plane.md`** (this file) — `## Checklist` box 3 ticked;
  the "Nothing is ticked" note under the checklist rewritten to say what is ticked and why
  the rest is not; one paragraph added to `## What changed` so the ticked item crosswalks to
  evidence in that section, as `receipt-per-issue` rule 3 requires (the crosswalk reads only
  `## What changed` and `## Verification`, never an appended wave section); this section
  appended. Nothing else above this section was rewritten.
- **`docs/decisions.md`** — not changed for #928 by this commit. The #928 section was written
  by wave 1a and is current; this commit's decisions work is #922's `SB-loader` row, the
  pending-write overlay sub-table and register, and a new `## Perf and scale infrastructure
  (#927)` section. See `receipts/issue-922-snappier-blueprints.md` § `## w1 root doc commit`.

### Boxes ticked, with the evidence pointer for each

| Box | Ticked | Evidence |
| --- | --- | --- |
| 3 — the static tripwire fails a build in which an app query touches an undeclared entity (proven with a seeded violation) | **yes** | `## w1b — the static app entity tripwire`: `packages/blueprints/src/app-entity-tripwire.{ts,test.ts}`, the seeded reds demonstrated 2026-09-03 on both the read and the act half naming app, file and entity, four further synthetic seeded violations running on every build, and three verifier passes ending PASS at `8078afd8` |

### Boxes deliberately NOT ticked

- **Box 5** (`principal_kind = 'automation'` rows, `declined` rows asserted by the migration
  test, a widened manifest still parks). PR #949 **merged** while this commit was being
  prepared and w1c is on this branch, so the root re-judged the box against the landed
  evidence rather than against the PR's absence: `## w1c — the automation principal kind in
  the schema` widens the schema CHECK and the authority registry so the plane **accepts** an
  automation answer, and says in its own first paragraph that **nothing writes one** and
  that "accepting a value in a CHECK is not, on its own, any of #928's acceptance criteria".
  The box's three clauses — every automation's standing answer is a row, the owner's prior
  refusals survive as `declined` rows with count and content asserted by the migration test,
  and a widened manifest still parks — all need wave 3's writer and migration. Unticked.
- **Box 12** (the three docs state the model *and* the drift register rows are closed). The
  docs state it; ONT-16…ONT-21 are `open`. Both halves are required.
- Every other box needs code from waves 2–5.

### Decisions

- **A tick needs its text inside `## What changed` or `## Verification`, not just inside the
  wave section that earned it.** `receipt-per-issue`'s crosswalk stops at the next `## `
  heading, so an appended `## w1b …` section is invisible to it. Rather than weaken the
  directive or leave the box untickable, the root added one crosswalk paragraph naming the
  evidence and pointing at the wave section. This is the one edit above an appended section
  that the root doc commit makes, and it adds no claim the w1b evidence does not already
  carry.

### Verification

```
bun run format                    # clean
bun run lint                      # clean
bun run lint:product              # 39/39
bash .governance/run.sh           # 22/22
bun run test:claims               # 45 claims, 48 lanes, 193 derived flows
```

### Audit

Verdict: PASS — root doc commit; ticks are traceable to the evidence sections named above
## w2 — static replica shape composition

Wave 2 of #928, ruling AP-apps-declare: `buildReplicaShapes` stops asking the grant evaluator what an app may
mirror and reads the app's own build-time manifest instead. Acceptance clause served — **"Replica shapes are
composed statically from the app manifest and the sealed registry; shape ids for all eight apps are unchanged
on the golden vault; a sealed column name appears in no shape."** Nothing ticked above.

### Files

| file | change |
| --- | --- |
| `packages/server/src/routes/replica-declared-scopes.ts` | new: the declared-manifest registry (`recordDeclaredManifest`, `declaredManifestFor`, `coveringReadScope`), keyed by the vault handle |
| `packages/server/src/routes/replica-grantees.ts` | **deleted** — `readGrantees` and its four-table grantee join have no reader |
| `packages/server/src/routes/replica-shape.ts` | `buildReplicaShapes` walks the install register + the declared manifest; the `evaluateAccess` call is gone; `REPLICA_MAX_VALUE_BYTES` deleted for `DEFAULT_REPLICA_TEXT_CEILING_BYTES` |
| `packages/server/src/serve/vault-plane.ts` | `ensureAppInstallGrant` records the manifest it was handed; the literal default purpose becomes `DEFAULT_INSTALL_PURPOSE` |
| `packages/server/src/routes/replica-projection.ts` | `SHAPE_CONTROL_ENTITIES` shrinks to `access.app` + `access.app_ext`; the `core.concept`, `access.policy`, `access.grant` and `access.grant_scope` verdicts, `activeAt` and `grantMatches` deleted |
| `packages/server/src/routes/replica-routes.ts`, `scripts/lint-vault-sql.mjs` | byte-ceiling import swapped to the vault constant; the `replica-grantees.ts` allow-list entry removed (the file is gone) and two neighbouring reasons restated |
| `packages/server/src/routes/replica-shape-parity.test.ts` | new: the eight pinned shape ids, the year-3 repeat, the sealed-column tripwire |
| `packages/server/src/routes/replica-shape.test.ts`, `packages/server/src/routes/replica-grant-shape.test.ts`, `packages/server/src/routes/replica-projection.test.ts`, `packages/server/src/routes/replica-routes.test.ts`, `packages/server/src/routes/replica-intent-route.test.ts` | set-up moves from `approveGrant` to `ensureAppInstallGrant`; the purpose-keyed and two-grant shape cases become one manifest, the doorbell case two apps, and three grant revocations become `revokeApp` or a re-declared manifest — what now moves a shape |

### Numbers

Host 4 cores / 15 GB, Node 22, worktree `claude/928-ac-work` on `claude/928-authority-composition`; one
`buildReplicaShapes` call over the eight bundled apps installed from their shipped `app.json`, counted by
wrapping `DatabaseSync.prepare` (`FROM|JOIN access_grant|access_grant_scope|access_policy|core_concept`).

| measure | before | after |
| --- | --- | --- |
| grant / policy / purpose statements per eight-app shape build | 3521 | **0** |
| prepared statements of any kind, same build | 3913 | 393 |
| shapes built / shape ids changed | 8 / — | 8 / **0** |

### Deleted, with its replacement

`readGrantees` (and `replica-grantees.ts`) → `installedApps` over `access_app` plus `declaredManifestFor`; the
per-entity `evaluateAccess` call → `coveringReadScope` over the declared scopes; `REPLICA_MAX_VALUE_BYTES` →
`DEFAULT_REPLICA_TEXT_CEILING_BYTES` (same 64 KiB, so no digest moved); three shape-control verdicts → nothing,
`access_policy` having had no writer since #916 and grants no longer deciding a shape.

### Decisions

- **`purpose` and the declared row filters / field masks stay in the shape this wave.** AP-apps-declare ends
  with a manifest "minus purpose, minus row filters and field masks", but the same wave's acceptance clause
  requires all eight shape ids unchanged, and both cannot hold: dropping the field masks alone moves `locker`
  to `locker:d777d60745f0179649f17329` and `people` to `people:a6efd1932c28e9a8a33e8bb1` (reproduced below),
  rebootstraps every device holding them, **and widens** three replicas from one entity type's revisions to
  every app's. They stay until w1b's work order re-expresses them as `WHERE` clauses in the owning queries;
  `purpose` rides opaquely from `vault.purpose` for the same reason. Reported to the root as a finding.
- **The declared manifest is held per vault handle in the gateway process, not in a table** — it is a
  build-time constant of the app's own code, so a row would be derived state, and a `WeakMap` on the vault
  handle keeps two vaults running different versions of one code-store app from sharing a shape. Its one
  writer is `ensureAppInstallGrant`, already the only path that reads an `app.json`.
- **`SHAPE_CONTROL_ENTITIES` and its verdict were edited in `replica-projection.ts`**, which the lane brief
  assigns elsewhere: leaving `access.grant` in the set after grants stop deciding a shape would rebootstrap
  every device for a row nothing reads. `REPLICA_COMPACTION_HELD_ENTITIES` in `packages/vault` stays a
  superset (its test asserts containment) and is wave 4's to shrink.

### Verification

```
bun run format                    # clean
bun run lint                      # clean
bun run lint:product              # 39/39
bash .governance/run.sh           # 22/22
bun run test:claims               # 45 claims, 48 lanes, 193 derived flows
```

### Audit

Verdict: PASS — root doc commit; ticks are traceable to the evidence sections named above
git rev-parse HEAD^{tree}   # the tree these ran against; quoted in the lane report
bun run format ; bun run lint                                    # clean
bun run --cwd packages/server typecheck                          # clean
bun run --cwd packages/server test                               # 3456 tests; 0 red from this diff
bun run --cwd packages/server test -- --run src/routes/replica-shape-parity.test.ts
bash .governance/run.sh
```

**Demonstrated red.** Forcing `fieldMask: null` fails 2 of 3 parity cases with the `locker` and `people` ids
moving, so the parity test is not vacuous; the sealed case asserts the registry names more than five real
secrets before looking for them. **Pre-existing reds on this host, reproduced with the diff stashed:**
`src/serve/gateway-db-lock.integration.test.ts`, two root/`IS_SANDBOX` cases in `src/acp/backends/acp/launch.test.ts`.

### Findings and doc debt

1. **A7 (Locker) needs no code.** `packages/blueprints/apps/locker/queries/access.ts` already passes
   `object_type in ["locker.item","locker.auth"]` as its own `where`, `queries-reveal-access.test.ts` pins it,
   and `access.receipt` reaches no replica shape at all — the history query filters in SQL today. Left over is
   the header's "THE ROW FILTER IS THE BOUNDARY", which AP-locker-boundary supersedes; editing it trips
   `check:ui-receipt` with no screen to photograph, so it waits for a wave that moves a Locker surface.
2. **Wave 4 inherits the three readers this wave could not retire without widening** — the declared row
   filters, the field masks and `purpose`.
3. Doc debt: `docs/vault-ontology.md` ONT-18 (`access_policy` read twice per non-owner read) — the shape path
   no longer consults it, still true of `gateway/access.ts`, wave 4 closes; `year3-shape.ts` and
   `replica/snapshot.ts` both name `DEFAULT_REPLICA_MAX_VALUE_BYTES`, a constant with no such name today.

## w3a — automations are principals

#928 A3 / AP-automation-principal. An automation's standing answer leaves the app-grant plane and becomes
`share_authority` rows. Acceptance clause served: **"Every automation's standing answer is a `share_authority`
row with `principal_kind = 'automation'`; the owner's prior refusals survive as `declined` rows (count and
content asserted by the migration test); a widened manifest still parks."** Nothing ticked above.

| file | change |
| --- | --- |
| `packages/vault/src/grant/automation-authority.ts` | new: `automationSubjectsOf` (manifest scope → `agent.pack`/`core.entity` × read\|act, `reveal` mints nothing), `recordAutomationAnswers`, `revokeAutomationAnswers`, `automationAnswers`, `backfillAutomationAnswers` |
| `packages/vault/src/index.ts` | the five functions, two subject constants and five types exported |
| `packages/server/src/serve/vault-plane.ts` | `approveAgentGrant` mints `granted`; `decideScopeRequest`'s deny branch mints `declined`; `revokeApp` revokes; `listAgents()` carries `answers`; the constructor runs the one-shot backfill |
| `packages/server/src/serve/vault-plane-automation-authority.test.ts` | new: the seven cases below |

| measure | value |
| --- | --- |
| rows minted for a 3-scope manifest (`read+act` pack, entity `read`, `reveal`) | 3 (`reveal` mints none) |
| backfill statements per vault open once any answer exists | 1 (`automationAnswers` probe) |
| legacy rows deleted by the migration | 0 — lossless; wave 4 deletes the tables |
| open scope requests altered by the migration | 0 — a parked ask is not an answer |

### Decisions

- **Answers are minted where the owner ANSWERS, not where the manifest is read.** `approveAgentGrant` is the
  one path both the install-time approval and the decision on a parked widening run through; a manifest that
  only parks reaches `openScopeRequest` and mints nothing, which is what keeps "a widened manifest still parks"
  true by construction rather than by a second check.
- **One row per automation** (open question 4): `principal_id` is the automation's own id, its agent
  enrolment's `enrollment_key`, not its agent party or its pack.
- **The migration is a mount-time one-shot in `packages/vault`, not a `VAULT_MIGRATIONS` rung.** `VAULT_MIGRATIONS`
  holds exactly one composed baseline rung, and the ONT-ladder ruling reserves a second rung for the first
  change after a release. It is idempotent (returns at its first statement once any answer exists), lossless
  (reads legacy rows, deletes none) and excludes `_assistant` by name, since the assistant holds no standing
  answer at all.
- **Not landed, and why**: `headless-automation-compile.ts` "minus purpose" — `vault.purpose` is `requireString`
  in `packages/server/src/automation/manifest/manifest.ts` and is read by `build-gateway.ts:2998`,
  `automation-turn-context.ts:87` and `build-extra-prompt.ts:93`, all outside this lane's reading set.
  Reported to the root; it costs nothing to defer, because the install path already defaults the purpose.

### Verification

```
git rev-parse HEAD^{tree}   # the tree these ran against; quoted in the lane report
bun run --cwd packages/vault build ; bun run --cwd packages/server typecheck   # clean
bun run --cwd packages/server test -- --run src/serve/vault-plane-automation-authority.test.ts   # 7 passed
```

### Falsification

| claim at risk | throwaway check | result |
| --- | --- | --- |
| The migration actually migrates — the assertions are not satisfied by the live write path that already ran | early-returned `backfillAutomationAnswers` before its guard, rebuilt `packages/vault`, re-ran | **red**: `re-opening a vault backfills automation grants and refusals losslessly` fails, 6 others pass — so only that case depends on the backfill |
| A widened manifest could be answered by the install path rather than parked | asserted the widened scope is absent from the answers AND that a scope request is open, in the same case, before deciding it | held: `granted agent.pack media read` appears only after `decideScopeRequest(_, true)` |

## w3b — the assistant holds no standing grant

#928 A3 / AP-automation-principal, second half. Acceptance clause served: **"The assistant holds no standing
grant; its reads and writes are receipted exercises on behalf of the acting owner; scheduler-fired automations
are capped by their row."** Nothing ticked above.

| file | change |
| --- | --- |
| `packages/vault/src/gateway/types.ts` | `Identity.assistant?: true` — set from the enrolment row, never claimable from a credential |
| `packages/vault/src/gateway/identity.ts` | `authenticate` reads `enrollment_key` in the statement it already ran and flags `_assistant` |
| `packages/vault/src/gateway/access.ts` | one clause after the execution clamp: an assistant identity with an acting owner who owns this vault is allowed, clamped, with no grant lookup |
| `packages/server/src/serve/vault-plane.ts` | `invokeAsAssistant` loses its self-healing `createGrant`, its schema sweep and its tombstone loop, and carries `onBehalfOfOwner`; `sqlAsOwner` → `sqlAsAssistant`, refusing when no acting owner owns the vault, and the decorative `purpose: "owner-assistant"` is gone |
| `packages/server/src/runs/assistant-conversation-runner.ts`, `packages/server/src/backup/backup.integration.test.ts`, `packages/server/src/lifecycle/ext-band-over-http.test.ts` | the three `sqlAsOwner` callers |
| `packages/server/src/routes/vault-routes.test.ts`, `packages/server/src/serve/vault-plane-commons.test.ts`, and the two test files above | eight assistant calls now run inside the owner frame the shell supplies — the harness had been exercising a surface that no longer exists without one |
| `packages/server/src/serve/vault-plane-assistant.test.ts` | rewritten: the standing grant is gone, so the suite holds the containment that replaces it |

| measure | before | after |
| --- | --- | --- |
| `share_authority` / `access_grant` rows the assistant holds | 1 grant, one scope per `agent_command.owner_schema`, self-healing | **0** |
| grant statements per assistant invoke | 1 grant + 1 scope + 1 schema sweep + 1 tombstone read, then a `createGrant` on any new schema | 0 (the clause returns before `activeGrants`) |
| `sqlAsOwner` production callers | 1 (`assistant-conversation-runner`) + 2 tests | 0 — deleted |
| server test files that had to gain an owner frame | — | 4 (8 call sites) |

### Decisions

- **`sqlAsOwner` is deleted, not renamed away from its callers.** Enumerated first, as the brief required: one
  production caller and two tests, all the assistant's. `gateway.sql` is owner-only by construction and
  receipts both the allow and the refusal, so the replacement keeps the owner-device credential and adds the
  check that was missing — no acting owner who owns this vault, no whole-model SQL. Strictly narrower than
  what it replaced.
- **The allowance is narrowed by the enrolment row, not by the credential.** `Identity.assistant` is derived
  inside `authenticate` from `access_agent.enrollment_key`, so a caller cannot claim it, and it is read from
  the statement identity already ran — no extra work per invocation.
- **Scheduler-fired automations are capped by their row**, unchanged by this slice and now true by absence: a
  run with no owner behind it has no `onBehalfOfOwner`, so it falls through to the grant path and its w3a
  `automation` answer, exactly as an interactive automation does.

### Verification

```
git rev-parse HEAD^{tree}   # the tree these ran against; quoted in the lane report
bun run --cwd packages/vault build ; bun run --cwd packages/server typecheck   # clean
bun run --cwd packages/server test -- --run src/serve/vault-plane-assistant.test.ts   # 6 passed
bun run --cwd packages/server test -- --run src/serve/authz-deny-matrix.test.ts src/serve/agent-owner-cap.test.ts src/serve/authz-matrix.smoke.test.ts
```

### Falsification

| claim at risk | throwaway check | result |
| --- | --- | --- |
| The assistant allowance cannot be widened to every agent without a suite noticing | flipped the flag in `authenticate` to match every enrolment key, rebuilt `packages/vault`, re-ran | **red** on `an ordinary automation on the same owner frame is still capped`. It took two attempts to make this bite: the deny-matrix and smoke suites stayed green under the same mutation, and so did the first version of the case, which built its bridge outside the owner's frame and was therefore denied for the ordinary reason. Both facts are in the diff — the case now builds the bridge inside the frame, and the comment says why |
| Deleting the standing grant left the assistant working through some other path | disabled the new clause in `evaluateAccess` (`if (false && …)`), rebuilt, re-ran | **red**: the low-risk execute becomes `denied`, so the clause is the only thing carrying it |

## Follow-up — PR verification repair

The w3b authority change requires `invokeAsAssistant` to run inside the
owner request frame; otherwise an assistant call has no acting owner and is
correctly denied. `tests/quality/user-facing-qualities.test.ts` retained one
pre-w3b unscoped call in the classified-write canary. The test now supplies
the same owner frame as the server shell, preserving the no-standing-grant
and confirmation-parking contract.

### Verification

```
bun run test:qualities                                      # 10 files, 60 tests passed
bun run format:check                                        # passed
bun run lint -- --format github                             # 0 warnings, 0 errors
bun run --cwd packages/server typecheck                     # passed
bun run --cwd packages/server test -- --run src/serve/vault-plane-assistant.test.ts  # 6 passed
```

## Follow-up — diff-coverage repair

The first PR CI run reached all tests but the aggregate diff-coverage lane
reported 51.3% (136/265 changed instrumentable lines), principally because
the new authority implementation was only exercised through the built vault
package entrypoint. `packages/vault/src/grant/automation-authority.test.ts`
now exercises the source directly, including unknown verbs, answer
replacement, revocation, legacy grant/tombstone backfill, idempotence, and
assistant exclusion. `packages/server/src/routes/replica-routes.test.ts` also
exercises the newest-priority path that reads a document through the changed
replica ceiling.

### Verification

```
bun run --cwd packages/vault test -- --coverage --run src/grant/automation-authority.test.ts  # changed source 100% lines
bun run --cwd packages/server test -- --coverage --run src/routes/replica-routes.test.ts      # changed read line covered
bun run --cwd packages/server test -- --run src/routes/replica-routes.test.ts                # 17 passed
```

## w4a — the evaluator retires; the vault engine

`packages/vault` only. `evaluateAccess` stops asking the app grant plane, the app grant tables leave the
schema, and `access_receipt` is re-keyed to one id space. Serves in part: **"`evaluateAccess` has no `app`
identity path"**, **"`access_grant`, `access_grant_scope`, `access_policy`, `access_scope_tombstone`,
`access_scope_request` and every reader of them are gone"**, **"`access_receipt` references `authority_id`
from one id space; the purpose column is gone"**. The bridge, dashboard and `dpv:` sweep land in w4b/w4c.

### Files

| file | change |
| --- | --- |
| `gateway/access.ts` | rewritten (>50%): owner-direct, assistant-on-acting-owner, `share_authority` `automation` row. No purpose, policy, grant or `app` |
| `gateway/types.ts` | `Credential.app` deleted; `device` gains `surface` (attribution) + host-resolved `scopeClamp` (narrows only); `Identity` gains `principalId`/`surface`; `purpose` off every request |
| `gateway/identity.ts` | app branch gone; an agent carries `enrollment_key` as `principalId`; a surface names itself on the owner's own credential |
| `gateway/evidence.ts` | `ReceiptInput.authorityId`; purpose off the row and out of the hash; new `skipsAllowReceipt` |
| `gateway/duties.ts` | `revokeGrantCascade` → `revokeAuthorityCascade`; `enforceRetention` + `RETENTION_REFUSALS` **deleted** with `access_policy` |
| `gateway/gateway.ts` | a named surface still confirms; `callerKind`/`callerName` read the surface for the owner's prompt |
| `schema/{access,audit,authority,migrate,entity-catalog}.ts` | five tables dropped; `access_app.revoked_at`; `access_receipt.authority_id` replaces `grant_id`; `share_authority_request` added |
| `{bootstrap,host}.ts` | `createGrant`, `listActiveGrants`, `listActiveAgentGrants`, `purposeConceptId`, `GrantSummary`, DPV seeds deleted; a revoked enrolment name is reusable |
| `install-memory.ts` → `grant/authority-request.ts` | tombstones and `hasGrantHistory` deleted; the parking half re-homed, keyed by principal |
| `grant/automation-authority.ts` | `hasAnsweredEver`, `scopeForSubject`; `backfillAutomationAnswers` deleted with the legacy tables |
| `grant/automation-principal.test-fixtures.ts` | new: what 31 suites used `createGrant` + an app credential for |
| `tests/claims.json` | four `consent-*` law statements rewritten one for one to the new plane |
| `scripts/docs-site/src/content/ontology-body.html` | §03 drops the four retired tables; `share.authority_request` joins the machinery band |

### Numbers

| measure | before | after |
| --- | --- | --- |
| statements an owner-device read runs against grant/policy tables | 4 | **0** |
| durable audit appends per owner-direct read/search/resolve/changes | 1 | **0** |
| refusal classes the manifest sweep can produce | 6 | **4** |

### Deleted, with its replacement

`access_grant`/`access_grant_scope` → `share_authority` rows with `principal_kind='automation'`;
`access_scope_tombstone` → `declined` answers; `access_scope_request` → `share_authority_request`;
`access_policy` + `enforceRetention` → nothing (no writer since #916; the purge canary moves to the
thread-projection heal); the `app` credential → the owner's device naming a `surface`; DPV purposes → nothing.

### Decisions

- **Declared row filters and field masks stay** (root ruling, deviating from A1): build-time properties of an
  app's own code, not grants. `evaluateAccess` stops reading the grant plane for them; the host bridge passes
  them as the same `scopeClamp` an automation already carries, which only ever narrows.
- **`Identity.surface` is attribution, never authority** — never read by `evaluateAccess`;
  `consent-standing-answer-required` asserts a surface identity reaches exactly what the bare owner device does.
- **A parked ask is not an answer**: `share_authority_request` is registered, so a restore keeps an open question.
- **The golden corpus is re-frozen, not migrated** — `golden-vault.test.ts` names re-freezing as the remedy.

### Laws rewritten in `tests/claims.json`

Five `consent-*` statements re-stated on the new plane, one for one, each keeping its property;
`consent-explicit-scope-unbypassable` (the minimization-policy law, whose table is deleted) is replaced by
`consent-standing-answer-required`, which carries the surface-confers-nothing property instead. No law deleted
without a replacement: `consent-denial-monotone`, `consent-clamp-only-narrows`, `consent-reveal-never-rides`,
`consent-standing-answer-required`, `consent-onbehalf-cap-precedes-grants`. A tightening, not a widening — no root
sign-off owed.

### Paths

```
packages/test-kit/src/year3-replica.ts
packages/vault/README.md
packages/vault/src/blob/derivatives.test.ts
packages/vault/src/blob/flow.test.ts
packages/vault/src/blob/preview.test.ts
packages/vault/src/bootstrap.ts
packages/vault/src/commands/atlas.test.ts
packages/vault/src/commands/attachments.test.ts
packages/vault/src/commands/documents-purge.test.ts
packages/vault/src/commands/documents.test.ts
packages/vault/src/commands/inline-body-guard.test.ts
packages/vault/src/commands/knowledge.test.ts
packages/vault/src/commands/links.test.ts
packages/vault/src/commands/links.ts
packages/vault/src/commands/locker-test-kit.ts
packages/vault/src/commands/locker.test.ts
packages/vault/src/commands/media-forget-person.test.ts
packages/vault/src/commands/media-gazetteer.test.ts
packages/vault/src/commands/media-places.test.ts
packages/vault/src/commands/media-purge.test.ts
packages/vault/src/commands/media.test.ts
packages/vault/src/commands/merge.test.ts
packages/vault/src/commands/organize-domains.test.ts
packages/vault/src/commands/outbox.test.ts
packages/vault/src/commands/parties.test.ts
packages/vault/src/commands/people-dates.test.ts
packages/vault/src/commands/people-debts.test.ts
packages/vault/src/commands/people.test.ts
packages/vault/src/commands/people.ts
packages/vault/src/commands/provider-writeback.test.ts
packages/vault/src/commands/revisions.ts
packages/vault/src/commands/schedule-organize.test.ts
packages/vault/src/commands/schedule.test.ts
packages/vault/src/commands/share.test.ts
packages/vault/src/commands/share.ts
packages/vault/src/commands/social.test.ts
packages/vault/src/commands/sync.test.ts
packages/vault/src/commands/tags.test.ts
packages/vault/src/commands/tally-groups.test.ts
packages/vault/src/commands/tally-identity.test.ts
packages/vault/src/commands/tally-ledger-test-kit.ts
packages/vault/src/commands/tally-receipts.test.ts
packages/vault/src/commands/tally.test.ts
packages/vault/src/commands/tasks.test.ts
packages/vault/src/enrich/clusters.test.ts
packages/vault/src/enrich/enrich.test.ts
packages/vault/src/enrich/face-clusters.test.ts
packages/vault/src/enrich/memories.test.ts
packages/vault/src/gateway/access-properties.test.ts
packages/vault/src/gateway/access.ts
packages/vault/src/gateway/acting-owner.test.ts
packages/vault/src/gateway/activity-read.test.ts
packages/vault/src/gateway/cards.test.ts
packages/vault/src/gateway/cards.ts
packages/vault/src/gateway/custody.ts
packages/vault/src/gateway/demo.test.ts
packages/vault/src/gateway/demo.ts
packages/vault/src/gateway/duties-helpers.test.ts
packages/vault/src/gateway/duties.test.ts
packages/vault/src/gateway/duties.ts
packages/vault/src/gateway/evidence.test.ts
packages/vault/src/gateway/evidence.ts
packages/vault/src/gateway/execution-clamp.test.ts
packages/vault/src/gateway/execution.test.ts
packages/vault/src/gateway/execution.ts
packages/vault/src/gateway/ext-sealed.test.ts
packages/vault/src/gateway/ext.test.ts
packages/vault/src/gateway/filters.ts
packages/vault/src/gateway/gateway.contract.test.ts
packages/vault/src/gateway/gateway.ts
packages/vault/src/gateway/identity.ts
packages/vault/src/gateway/locker-auth.ts
packages/vault/src/gateway/locker-sidecar-reveal.test.ts
packages/vault/src/gateway/portability.test.ts
packages/vault/src/gateway/portability.ts
packages/vault/src/gateway/portable-sealed-custody.test.ts
packages/vault/src/gateway/read-batch.test.ts
packages/vault/src/gateway/read-order.test.ts
packages/vault/src/gateway/read-truncation.test.ts
packages/vault/src/gateway/reseal.ts
packages/vault/src/gateway/seal-custody.test.ts
packages/vault/src/gateway/sealed.test.ts
packages/vault/src/gateway/search.test.ts
packages/vault/src/gateway/search.ts
packages/vault/src/gateway/share-grant-seam.test.ts
packages/vault/src/gateway/sql.test.ts
packages/vault/src/gateway/types.ts
packages/vault/src/grant/authority-request.test.ts
packages/vault/src/grant/authority-request.ts
packages/vault/src/grant/automation-authority.test.ts
packages/vault/src/grant/automation-authority.ts
packages/vault/src/grant/automation-principal.test-fixtures.ts
packages/vault/src/grant/fulfillment.test.ts
packages/vault/src/host.test.ts
packages/vault/src/host.ts
packages/vault/src/index.ts
packages/vault/src/ingest/staging.test.ts
packages/vault/src/ingest/staging.ts
packages/vault/src/install-memory.test.ts
packages/vault/src/install-memory.ts
packages/vault/src/journal-archive.test.ts
packages/vault/src/replica/change-log.test.ts
packages/vault/src/replica/change-log.ts
packages/vault/src/replica/intents.test.ts
packages/vault/src/replica/invocation-commits.test.ts
packages/vault/src/replica/invocation-commits.ts
packages/vault/src/replica/parked.test.ts
packages/vault/src/replica/parked.ts
packages/vault/src/schema/access.ts
packages/vault/src/schema/audit-band.test.ts
packages/vault/src/schema/audit.ts
packages/vault/src/schema/authority.ts
packages/vault/src/schema/entity-catalog.ts
packages/vault/src/schema/fts-index-budget.test.ts
packages/vault/src/schema/migrate.ts
packages/vault/src/schema/ontology-rules.test.ts
packages/vault/src/schema/ontology-shape.test.ts
packages/vault/src/share/closure-confinement.contract.test.ts
packages/vault/src/share/commons-automation-b6.test.ts
packages/vault/src/share/commons-convergence-properties.test.ts
packages/vault/src/share/commons-decide.ts
packages/vault/src/share/commons-invoke.test.ts
packages/vault/src/share/commons-replay.test-fixtures.ts
packages/vault/src/share/commons-sim-grant-world.test-fixtures.ts
packages/vault/src/share/commons-sim-grant.test-fixtures.ts
packages/vault/src/share/commons-sim-world.test-fixtures.ts
packages/vault/src/share/commons-tally-grant.test.ts
packages/vault/src/share/commons.test.ts
packages/vault/src/share/commons.ts
packages/vault/src/share/docs-folder.test.ts
packages/vault/src/wal-shipper.ts
packages/vault/tests/golden/issue-916/manifest.json
packages/vault/tests/golden/issue-916/vault.db.gz
scripts/docs-site/src/content/ontology-body.html
tests/claims.json
```

### Verification

```
git rev-parse HEAD^{tree}
bun run --cwd packages/vault typecheck    # passed
bun run --cwd packages/vault build        # clean
bun run --cwd packages/vault test         # 204 files, 1600 passed, 2 skipped, 0 failed
bun run golden-vault:freeze -- --label issue-916
```

### Falsification

| claim at risk | throwaway check | result |
| --- | --- | --- |
| An automation is refused reveal because reveal rides no answer, not because fixtures stopped asking | removed the `verb === "reveal"` early return in `standingAnswerId`, re-ran `sealed.test.ts` | **green at first** — the finding: `automationSubjectsOf` mints no `reveal` row, so the guard was untested. The case now FORGES a `granted` reveal row into `share_authority`; with the guard removed it is **red** |
| Owner-direct reads really stopped receipting, rather than the tests stopping counting | forced `skipsAllowReceipt` to `false`, re-ran `read-batch` | **red** on `an owner-direct batch writes NO receipts at all` (3 rows appear) and on the refusal case (2 instead of 1) |

## w4b — the host: the app bridge stops asking for a grant

`packages/server`, the automation handler pack and the root suites. The app bridge issues no app credential:
it opens the owner's own device credential, NAMES the surface, and carries the app's build-time manifest as
the execution clamp the gateway already had. The grant routes and the grant half of the vault plane go with
the tables w4a dropped. Serves in part: **"the app bridge issues no app credential; an owner-device read of
the owner's vault runs 0 grant statements"** and **"every reader of them is gone"**.

### Files

| file | change |
| --- | --- |
| `packages/server/src/serve/vault-plane.ts` | `bridgeFor` mints `{kind:"device", surface, scopeClamp}` from `declaredManifestFor`; `approveGrant`/`listGrants`/`revokeGrant`/park-by-grant deleted; `recordAppInstall` replaces the install grant; `readBatch` bridge op |
| `packages/server/src/routes/vault-routes.ts` | `POST /apps/:id/grants` deleted with `parseGrantRequest`'s purpose; the automation answer route keeps the same URL and loses `purpose`; companion module state reads the install register |
| `packages/server/src/routes/replica-shape.ts` | shape composition reads the declared manifest only |
| `packages/server/src/serve/build-gateway.ts` | `grantScopesFromDir` records a declaration; no grant is minted at mount |
| `packages/server/src/automation/handler/runner.ts` | the handler rail stops sending a purpose with every `invoke` |
| `packages/server/src/serve/manifest-scope-denial.*` | the clamp sweeps keep their refusal classes against the one plane |
| root suites (`tests/quality`, `tests/scale`, `tests/perf`, `tests/integration-mobile`) | the retired `purpose` field off every fixture and call |

### Numbers

| measure | before | after |
| --- | --- | --- |
| `packages/server` suite | — | 400 files, 3512 passed, 3 expected-fail, 7 skipped, **3 failed (container-known)** |
| HTTP routes that mint or read an app grant | 3 | **0** |

### Deleted, with its replacement

`POST /vaults/:id/apps/:app/grants` and `plane.approveGrant`/`listGrants`/`revokeGrant` → `recordAppInstall`,
which records the app's own `app.json` manifest; the grant-shaped `purpose` on the automation answer route →
nothing.

### Decisions

- **A declaration is not durable state.** An app's reach is its build-time manifest, re-read from `app.json`
  by the mount pass (`hostFor`) on every boot for every store and bundled app, so it is held per vault handle
  rather than persisted. An app the mount pass has not run for reaches nothing — the fail-closed direction.
  Three suites that reached an APP bridge after `approveAgentGrant` (an AUTOMATION answer) now declare through
  `recordAppInstall`, which is the real install path; `vault-plane-wal` re-declares after the restart exactly
  as mounting would.
- **The declared manifest is enforced as the execution clamp**, not as a grant (root ruling, deviating from
  A1's "minus filters and masks"). The property that depends on it: a first-party surface must not reach past
  what it declared — without the clamp, `notes` running on the owner's credential could reveal a Locker
  sidecar. It only ever narrows, so no deny in `authz-deny-matrix` becomes an allow.

### Verification

```
git rev-parse HEAD^{tree}
bun run --cwd packages/server build       # tsc -p tsconfig.json, clean
bun run --cwd packages/server typecheck   # passed
bun run --cwd packages/server test        # 3512 passed; reds: acp/launch x2 (IS_SANDBOX set), gateway-db-lock (no sqlite3 CLI)
bun run --cwd packages/server test -- --run src/serve/vault-plane-wal.test.ts src/serve/protocol-join-lane.test.ts src/serve/vault-plane-consent.test.ts   # 18 passed
```

### Paths

```
packages/model-runtime/automation-handlers/embed-image.js
packages/model-runtime/automation-handlers/embed-image.test.ts
packages/model-runtime/automation-handlers/embed-text.js
packages/model-runtime/automation-handlers/faces.js
packages/model-runtime/automation-handlers/faces.test.ts
packages/model-runtime/automation-handlers/photo-ocr.js
packages/model-runtime/automation-handlers/photo-ocr.test.ts
packages/model-runtime/automation-handlers/place-names.js
packages/model-runtime/automation-handlers/place-names.test.ts
packages/model-runtime/automation-handlers/transcript.js
packages/model-runtime/automation-handlers/transcript.test.ts
packages/server/src/acp/prompt-injection/harness.ts
packages/server/src/automation/fire/condition.test.ts
packages/server/src/automation/fire/condition.ts
packages/server/src/automation/fire/connector.test.ts
packages/server/src/automation/fire/fire-vault.test.ts
packages/server/src/automation/fire/fire.ts
packages/server/src/automation/handler/runner.ts
packages/server/src/automation/manifest/enricher-templates.test.ts
packages/server/src/automation/manifest/manifest-vault.test.ts
packages/server/src/automation/manifest/manifest.test.ts
packages/server/src/automation/manifest/manifest.ts
packages/server/src/automation/scaffold/scaffold-files.test.ts
packages/server/src/brief/daily-brief.ts
packages/server/src/engine/handlers/build-extra-prompt.ts
packages/server/src/engine/handlers/vault-bridge.test.ts
packages/server/src/engine/registry/manifest.test.ts
packages/server/src/engine/registry/manifest.ts
packages/server/src/enrich/semantic-search.test.ts
packages/server/src/lifecycle/automation-anchor-scopes.test.ts
packages/server/src/lifecycle/automation-anchor-scopes.ts
packages/server/src/lifecycle/automation-lifecycle-over-http.test.ts
packages/server/src/lifecycle/automation-turn-context.test.ts
packages/server/src/lifecycle/automation-turn-context.ts
packages/server/src/lifecycle/ext-band-over-http.test.ts
packages/server/src/lifecycle/headless-automation-compile.test.ts
packages/server/src/lifecycle/headless-automation-compile.ts
packages/server/src/lifecycle/install-over-http.test.ts
packages/server/src/lifecycle/interactive-automation-turn.test.ts
packages/server/src/reminders/due-reminders.test.ts
packages/server/src/reminders/due-reminders.ts
packages/server/src/routes/blob-routes-hardening.test.ts
packages/server/src/routes/blob-routes.test.ts
packages/server/src/routes/companion-grants.test.ts
packages/server/src/routes/companion-grants.ts
packages/server/src/routes/connections-routes.ts
packages/server/src/routes/enrich-search-routes.test.ts
packages/server/src/routes/grant-routes.test.ts
packages/server/src/routes/import-routes.ts
packages/server/src/routes/peer-commons-route.ts
packages/server/src/routes/push-wake-routes.test.ts
packages/server/src/routes/replica-declared-scopes.ts
packages/server/src/routes/replica-grant-shape.test.ts
packages/server/src/routes/replica-intent-attribution.test.ts
packages/server/src/routes/replica-intent-crash-replay.test.ts
packages/server/src/routes/replica-intent-route.test.ts
packages/server/src/routes/replica-projection.test.ts
packages/server/src/routes/replica-routes.test.ts
packages/server/src/routes/replica-shape-parity.test.ts
packages/server/src/routes/replica-shape.test.ts
packages/server/src/routes/replica-shape.ts
packages/server/src/routes/vault-enrich-rules-routes.ts
packages/server/src/routes/vault-routes.test.ts
packages/server/src/routes/vault-routes.ts
packages/server/src/runs/assistant-conversation-runner.ts
packages/server/src/serve/agent-owner-cap.test.ts
packages/server/src/serve/build-gateway.test.ts
packages/server/src/serve/build-gateway.ts
packages/server/src/serve/connection-broker.test.ts
packages/server/src/serve/connection-broker.ts
packages/server/src/serve/gateway-db.test.ts
packages/server/src/serve/grant-fulfillment.ts
packages/server/src/serve/manifest-scope-denial.closed-grammar.test.ts
packages/server/src/serve/manifest-scope-denial.fuzz.test.ts
packages/server/src/serve/manifest-scope-denial.hostile.test.ts
packages/server/src/serve/manifest-scope-denial.sweep.test-fixtures.ts
packages/server/src/serve/manifest-scope-denial.sweep.test.ts
packages/server/src/serve/outbox-executor.test.ts
packages/server/src/serve/peer-commons-client.ts
packages/server/src/serve/peer-commons-pull.test.ts
packages/server/src/serve/peer-commons-sweep.ts
packages/server/src/serve/protocol-join-lane.test.ts
packages/server/src/serve/serve-scheduler-reconcile.test.ts
packages/server/src/serve/vault-picker.ts
packages/server/src/serve/vault-plane-app-bridge.test.ts
packages/server/src/serve/vault-plane-assistant.test.ts
packages/server/src/serve/vault-plane-automation-authority.test.ts
packages/server/src/serve/vault-plane-commons.test.ts
packages/server/src/serve/vault-plane-consent.test.ts
packages/server/src/serve/vault-plane-links.test.ts
packages/server/src/serve/vault-plane-scopes.test.ts
packages/server/src/serve/vault-plane-wal.test.ts
packages/server/src/serve/vault-plane.ts
packages/server/src/serve/vault-registry.test.ts
packages/server/src/validate-manifest.test.ts
tests/integration-mobile/lib/gateway.ts
tests/perf/blob-egress.perf.test.ts
tests/quality/chaos-planner-app.ts
tests/quality/fixtures/kill-mid-write-child.ts
tests/quality/offline-reconnect.integration.test.ts
tests/quality/replica-bootstrap-fixture.ts
tests/quality/user-facing-qualities.test.ts
tests/scale/browser-replica-query.fixture.ts
tests/scale/replica-bootstrap.scale.test.ts
tests/scale/replica-reconnect.scale.test.ts
tests/scale/replica-sse-fanout.scale.test.ts
```

### Falsification

| claim at risk | throwaway check | result |
| --- | --- | --- |
| The bridge clamp really bites — an app is held to its declared manifest, not merely enrolled | ran the three repaired suites with `recordAppInstall` reverted to `approveAgentGrant` | **red**: `denied`, not `parked`/`executed`, in all three — an app with no recorded declaration reaches nothing, so the clamp is the thing deciding, not the enrolment row |
| The three remaining suite reds are the container's, not this diff's | read the two failing assertions and probed the environment they name: `env | grep IS_SANDBOX`, `which sqlite3` | `IS_SANDBOX=yes` is exported into this container (the suite asserts it is unset / `1`) and there is no `sqlite3` binary (the lock test shells out to it and reads `null`). Neither assertion touches the authority plane |

## w4c — the seats: one plane on screen, and when it was last used

`packages/client`, `packages/blueprints`, `apps/mobile`, plus the vault half that makes "last used" a fact
rather than a guess. The retired `purpose` selector leaves every replica shape, request and manifest; an app's
pane states what it DECLARED instead of offering a grant; and Settings → Access grows an Automations group, a
last-used line on every row, and the asks still waiting on the owner. Serves in part: **"Settings → Access
shows last-used for every row"** and **"`grep -r \"dpv:\" packages apps` is empty outside receipts and
CHANGELOG"**.

### Files

| file | change |
| --- | --- |
| `packages/vault/src/schema/authority.ts` | new `share_authority_use` (authority_id → last_used_at), one row per answer, no history, no FK — the audit band's `authority_id` is a value, and the commons rail receipts under ids this table does not hold |
| `packages/vault/src/gateway/evidence.ts` | new `writeAuthorityReceipt(db, input)`: the receipt and the stamp in one transaction from one id, so last-used can never disagree with the chain; `writeReceipt` stays band-agnostic for the journal and steward writers |
| `packages/vault/src/schema/entity-catalog.ts` | `share.authority_use` registered — a restore that forgot it would reset every row to "never used" |
| `packages/client/src/access-lens.ts` | `automation` joins the principal kinds and gets its own group; `AccessAnswer.lastUsedAt`; `AccessRequest` + `parseAccessRequests`/`parseAccessUse`; the two side reads are best-effort beside the answers |
| `packages/client/src/react/screens/SettingsAccessScreen.tsx` · `apps/mobile/src/screens/settings/AccessSection.tsx` | both seats draw "last used <date>" / "never used" per row and a "Waiting on you" block for undecided asks |
| `packages/client/src/react/screens/VaultScreen.tsx` | `GrantSection` **deleted**; "Requested access" becomes "Declared access" and the Purpose line goes — an app declares, it is not granted |
| `packages/client/src/react/screens/privacyStores.ts` | two kinds of holder: a DECLARED app (no revoke) and an ANSWERED automation (revocable), from `app.scopes` and `agent.answers` |
| `packages/client/src/gateway-client-vault.ts` | `approveVaultGrant` and `VaultGrant` **deleted**; `VaultAppEntry.scopes`, `VaultAgentEntry.answers` |
| `packages/client/src/replica/{types,shell-session,store-core,write-helpers}.ts` · `apps/mobile/src/lib/replica/{native-session,multi-vault-reader}.ts` | one app, one shape: `purpose` off the shape, the read, the search and the `replica_shape` table; the shape id is the only selector |
| `packages/blueprints/types/centraid.d.ts` + 34 app query modules | `purpose` off `ctx.vault.read/search/invoke/resolve/query` and every call site |
| `packages/blueprints/apps/people/app.json` | declares `share.authority_use` and `share.authority_request` |
| `packages/server/src/serve/vault-plane.ts` | `listApps()` carries each app's declared manifest, which is what the privacy store view draws |
| `apps/web/tests/e2e/settings-access.spec.ts` | new harness: the shipped screen in a real browser, emitting the evidence screenshot |

### Numbers

| measure | before | after |
| --- | --- | --- |
| `dpv:` occurrences under `packages/` + `apps/` (excluding `dist/`) | 12 | **0** |
| replica shapes an app may hold for one entity | many, selected by a caller-supplied purpose string | **one**, or an explicitly named shape id |
| Access rows carrying a last-used date | 0 | **every row** ("never used" where nothing has) |
| principal kinds the dashboard groups | 4 | **5** (automations) |
| suites | vault 204 files/1600 · client 270/2460 · blueprints 212/6651 · mobile 277/2387 · server 400/3512, all passing bar the three container reds |

### Deleted, with its replacement

`DEFAULT_REPLICA_PURPOSE` and `replica_shape.purpose` → the shape id alone; `VaultScreen`'s grant/revoke
section and `approveVaultGrant` → a statement of what the app declared; `VaultGrant`/`VaultAppEntry.grants` →
`VaultAppEntry.scopes` (declarations) and `VaultAgentEntry.answers` (answers); the ctx `purpose` argument →
nothing.

### Decisions

- **Last-used is a row of its own, not a column on the answer.** `share_authority` is what the member SAID and
  is immutable but for `revoked_at`; stamping it on every use would rewrite the answer and push a replica
  change each time an automation read anything. `share_authority_use` is one row per authority, upserted
  beside the receipt that cites it — O(1), no history, and a replica change only when the date actually moves.
- **The privacy store view keeps app rows.** Dropping them would have been simpler, but "which apps reach my
  photos" is the question that screen exists to answer; what changed is that an app's row is not offered a
  Revoke, because a declaration is not a grant and the button could not keep its promise.
- **A pinned digest moved, a policy did not.** `replica-shape-parity`'s `people` shape id and the sweep's
  `declaredScopes` count are pins over derived values; People declares two more entities on purpose, so both
  are re-pinned with the reason in the test.

### Verification

```
git rev-parse HEAD^{tree}
bun run --cwd packages/{vault,client,blueprints,server,test-kit,core,design} typecheck   # all pass
bun run --cwd apps/mobile typecheck                                                      # passes
bun run --cwd packages/vault test        # 204 files, 1600 passed, 2 skipped
bun run --cwd packages/client test       # 270 files, 2460 passed
bun run --cwd packages/blueprints test   # 212 files, 6651 passed
bun run --cwd apps/mobile test           # 277 files, 2387 passed
bun run --cwd packages/server test       # 400 files, 3512 passed; 3 container reds (IS_SANDBOX, no sqlite3)
CENTRAID_E2E_CHROMIUM=/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell \
  bun run --cwd apps/web e2e -- settings-access.spec.ts   # 1 passed
node scripts/golden-vault/build.mjs --label issue-916     # re-frozen for share_authority_use
```

## User impact

Settings → Access finally answers the question it was built for. Every answer now carries the date it was last
used — "last used Sep 3, 2026", or "never used" for one nothing has touched — so an automation you approved
months ago and forgot is visible as exactly that instead of sitting indistinguishable beside the ones you rely
on. Automations join people, harnesses and your devices as a group of their own, because an automation's reach
is now the same kind of standing answer theirs is. And an automation asking for MORE than you have agreed to
no longer waits silently: it appears at the top under "Waiting on you", with the scopes it is asking for, above
everything you have already answered. On an app's own settings pane, "Requested access" becomes "Declared
access": a first-party app runs on your device against your vault and its reach is fixed by its own code, so
the pane now states it plainly rather than offering a Grant button — and a Revoke that could not have kept its
promise is gone from the privacy ledger for apps, while automations keep theirs.

First-run: a fresh vault has no answers and nothing has used anything, so Access shows each group's "No
standing answers here." and no "Waiting on you" block at all — the empty state is unchanged, and no row is
drawn as "never used" until there is a row.

Evidence: `artifacts/e2e/ui-impact/issue-928-settings-access.png`, emitted by
`apps/web/tests/e2e/settings-access.spec.ts` (the shipped `SettingsAccessScreen`, its loader stubbed, in
headless Chromium). The phone seat renders the same `access-lens.ts` groups and the same two strings; there is
no mobile screenshot harness in this container, so CI must run the mobile evidence lane against this branch —
nothing is fabricated here.

### Paths

```
apps/mobile/src/apps/tally/PendingRestartJourney.test.tsx
apps/mobile/src/lib/replica/bootstrap-statement-budget.test.ts
apps/mobile/src/lib/replica/inline-query-ctx.native.test.ts
apps/mobile/src/lib/replica/mounted-read-plan.pushdown.test.ts
apps/mobile/src/lib/replica/mounted-read-plan.test.ts
apps/mobile/src/lib/replica/multi-vault-read-parity.test.ts
apps/mobile/src/lib/replica/multi-vault-reader.test.ts
apps/mobile/src/lib/replica/multi-vault-reader.ts
apps/mobile/src/lib/replica/native-replica-store.test.ts
apps/mobile/src/lib/replica/native-session.test-fixtures.ts
apps/mobile/src/lib/replica/native-session.ts
apps/mobile/src/lib/replica/off-thread-apply.test.ts
apps/mobile/src/lib/replica/ordered-read-plan.test.ts
apps/mobile/src/lib/replica/pending-write-visibility.test.ts
apps/mobile/src/lib/replica/reader-statement-budget.test.ts
apps/mobile/src/lib/replica/reconnect-to-fresh.fixture.ts
apps/mobile/src/screens/home/home-tile-reads.test.ts
apps/mobile/src/screens/settings/AccessSection.tsx
apps/web/tests/e2e/settings-access.spec.ts
packages/blueprints/apps/_shared/action-kit.test.ts
packages/blueprints/apps/_shared/action-kit.ts
packages/blueprints/apps/_shared/journal-scheme.ts
packages/blueprints/apps/_shared/pending-overlay.ts
packages/blueprints/apps/_shared/taxonomy-reads.ts
packages/blueprints/apps/agenda/app.json
packages/blueprints/apps/agenda/queries/day-context.ts
packages/blueprints/apps/agenda/queries/parties.ts
packages/blueprints/apps/agenda/queries/search.ts
packages/blueprints/apps/agenda/queries/upcoming.ts
packages/blueprints/apps/agenda/seed.js
packages/blueprints/apps/docs/app.json
packages/blueprints/apps/docs/queries/_shared.ts
packages/blueprints/apps/docs/queries/activity.ts
packages/blueprints/apps/docs/queries/drive.ts
packages/blueprints/apps/docs/queries/history.ts
packages/blueprints/apps/docs/queries/search.ts
packages/blueprints/apps/docs/seed.js
packages/blueprints/apps/locker/app.json
packages/blueprints/apps/locker/queries/access.ts
packages/blueprints/apps/locker/queries/autofill-candidates.ts
packages/blueprints/apps/locker/queries/autofill-item.ts
packages/blueprints/apps/locker/queries/item-sidecars.ts
packages/blueprints/apps/locker/queries/item.ts
packages/blueprints/apps/locker/queries/items.ts
packages/blueprints/apps/locker/queries/search.ts
packages/blueprints/apps/locker/queries/trash.ts
packages/blueprints/apps/locker/queries/watchtower.ts
packages/blueprints/apps/notes/actions/send-to-tasks.ts
packages/blueprints/apps/notes/app.json
packages/blueprints/apps/notes/queries/history.ts
packages/blueprints/apps/notes/queries/journal.ts
packages/blueprints/apps/notes/queries/library.ts
packages/blueprints/apps/notes/queries/link-targets.ts
packages/blueprints/apps/notes/queries/note.ts
packages/blueprints/apps/notes/queries/search.ts
packages/blueprints/apps/notes/seed.js
packages/blueprints/apps/people/app.json
packages/blueprints/apps/people/queries/_shared.ts
packages/blueprints/apps/people/queries/dashboard.ts
packages/blueprints/apps/people/queries/history.ts
packages/blueprints/apps/people/queries/journal.ts
packages/blueprints/apps/people/queries/people.ts
packages/blueprints/apps/people/queries/person.ts
packages/blueprints/apps/people/queries/search.ts
packages/blueprints/apps/people/queries/trash.ts
packages/blueprints/apps/people/seed.js
packages/blueprints/apps/photos/app.json
packages/blueprints/apps/photos/queries/_shared.ts
packages/blueprints/apps/photos/queries/duplicates.ts
packages/blueprints/apps/photos/queries/enrichment-status.ts
packages/blueprints/apps/photos/queries/face-queue.ts
packages/blueprints/apps/photos/queries/faces.ts
packages/blueprints/apps/photos/queries/library.ts
packages/blueprints/apps/photos/queries/people.ts
packages/blueprints/apps/photos/queries/search.ts
packages/blueprints/apps/photos/queries/storage.ts
packages/blueprints/apps/photos/seed.js
packages/blueprints/apps/tally/app.json
packages/blueprints/apps/tally/queries/activity.ts
packages/blueprints/apps/tally/queries/dashboard.ts
packages/blueprints/apps/tally/queries/export.ts
packages/blueprints/apps/tally/queries/friend.ts
packages/blueprints/apps/tally/queries/group.ts
packages/blueprints/apps/tally/queries/history.ts
packages/blueprints/apps/tally/queries/search.ts
packages/blueprints/apps/tally/seed.js
packages/blueprints/apps/tasks/app.json
packages/blueprints/apps/tasks/queries/board.ts
packages/blueprints/apps/tasks/queries/search.ts
packages/blueprints/apps/tasks/seed.js
packages/blueprints/automations/doc-entity-linker/automations/doc-entity-linker/automation.json
packages/blueprints/automations/doc-entity-linker/automations/doc-entity-linker/handler.js
packages/blueprints/automations/doc-filer/automations/doc-filer/automation.json
packages/blueprints/automations/doc-filer/automations/doc-filer/handler.js
packages/blueprints/automations/doc-text-extractor/automations/doc-text-extractor/automation.json
packages/blueprints/automations/doc-text-extractor/automations/doc-text-extractor/handler.js
packages/blueprints/automations/dropbox-pull/automations/dropbox-pull/automation.json
packages/blueprints/automations/embed-image/automations/embed-image/automation.json
packages/blueprints/automations/embed-image/automations/embed-image/handler.js
packages/blueprints/automations/embed-text/automations/embed-text/automation.json
packages/blueprints/automations/embed-text/automations/embed-text/handler.js
packages/blueprints/automations/faces/automations/faces/automation.json
packages/blueprints/automations/faces/automations/faces/handler.js
packages/blueprints/automations/github-pull/automations/github-pull/automation.json
packages/blueprints/automations/gitlab-pull/automations/gitlab-pull/automation.json
packages/blueprints/automations/google-calendar-invite-send/automations/google-calendar-invite-send/automation.json
packages/blueprints/automations/google-calendar-pull/automations/google-calendar-pull/automation.json
packages/blueprints/automations/google-contacts-pull/automations/google-contacts-pull/automation.json
packages/blueprints/automations/google-drive-pull/automations/google-drive-pull/automation.json
packages/blueprints/automations/google-gmail-pull/automations/google-gmail-pull/automation.json
packages/blueprints/automations/google-gmail-send/automations/google-gmail-send/automation.json
packages/blueprints/automations/linear-pull/automations/linear-pull/automation.json
packages/blueprints/automations/microsoft-calendar-pull/automations/microsoft-calendar-pull/automation.json
packages/blueprints/automations/microsoft-contacts-pull/automations/microsoft-contacts-pull/automation.json
packages/blueprints/automations/microsoft-onedrive-pull/automations/microsoft-onedrive-pull/automation.json
packages/blueprints/automations/microsoft-outlook-pull/automations/microsoft-outlook-pull/automation.json
packages/blueprints/automations/notion-pull/automations/notion-pull/automation.json
packages/blueprints/automations/obligation-extractor/automations/obligation-extractor/automation.json
packages/blueprints/automations/obligation-extractor/automations/obligation-extractor/handler.js
packages/blueprints/automations/photo-ocr/automations/photo-ocr/automation.json
packages/blueprints/automations/photo-ocr/automations/photo-ocr/handler.js
packages/blueprints/automations/place-names/automations/place-names/automation.json
packages/blueprints/automations/place-names/automations/place-names/handler.js
packages/blueprints/automations/renewal-reminders/automations/renewal-reminders/automation.json
packages/blueprints/automations/slack-pull/automations/slack-pull/automation.json
packages/blueprints/automations/todoist-pull/automations/todoist-pull/automation.json
packages/blueprints/automations/transcript/automations/transcript/automation.json
packages/blueprints/automations/transcript/automations/transcript/handler.js
packages/blueprints/src/app-manifest-reads.test.ts
packages/blueprints/types/centraid.d.ts
packages/client/src/access-lens.test.ts
packages/client/src/access-lens.ts
packages/client/src/gateway-client-automation-editing.ts
packages/client/src/gateway-client-outbox.ts
packages/client/src/gateway-client-vault.contract.test.ts
packages/client/src/gateway-client-vault.ts
packages/client/src/react/screen-contracts.ts
packages/client/src/react/screens/ApprovalsScreen.test.tsx
packages/client/src/react/screens/ApprovalsScreen.tsx
packages/client/src/react/screens/AutomationEditorScreen.test.tsx
packages/client/src/react/screens/AutomationEditorTriggers.test.tsx
packages/client/src/react/screens/SettingsAccessScreen.tsx
packages/client/src/react/screens/VaultScreen.test.tsx
packages/client/src/react/screens/VaultScreen.tsx
packages/client/src/react/screens/privacyStores.test.ts
packages/client/src/react/screens/privacyStores.ts
packages/client/src/react/shell/routes/ApprovalsRoute.tsx
packages/client/src/react/shell/routes/AutomationEditorRoute.test.tsx
packages/client/src/react/shell/routes/appSettingsData.test.ts
packages/client/src/react/shell/routes/appSettingsData.ts
packages/client/src/react/shell/routes/approvalsData.test.ts
packages/client/src/react/shell/routes/approvalsData.ts
packages/client/src/react/shell/routes/automationEditorData.ts
packages/client/src/react/shell/routes/automationEditorTriggers.ts
packages/client/src/react/shell/routes/automationEditorVault.test.ts
packages/client/src/react/shell/routes/automationThreadData.test.ts
packages/client/src/react/shell/routes/homeTileContent.test.ts
packages/client/src/react/shell/routes/homeTileContent.ts
packages/client/src/replica/app-convergence.contract.test.ts
packages/client/src/replica/convergence-properties.test.ts
packages/client/src/replica/coordinator.test.ts
packages/client/src/replica/deferred-values.test.ts
packages/client/src/replica/read-plan-parity.test-fixtures.ts
packages/client/src/replica/read-plan-refusals.test.ts
packages/client/src/replica/read-plan-truncation.test.ts
packages/client/src/replica/shell-session-admission.contract.test.ts
packages/client/src/replica/shell-session-scopes.test.ts
packages/client/src/replica/shell-session.test.ts
packages/client/src/replica/shell-session.ts
packages/client/src/replica/sqlite-store.test.ts
packages/client/src/replica/store-core-bootstrap-walk.test.ts
packages/client/src/replica/store-core.test-fixtures.ts
packages/client/src/replica/store-core.ts
packages/client/src/replica/store-docs-search.test.ts
packages/client/src/replica/types.ts
packages/client/src/replica/windowed-bootstrap.test-fixtures.ts
packages/client/src/replica/write-helpers.ts
packages/server/skills/automation-authoring/SKILL.md
packages/server/src/routes/replica-shape-parity.test.ts
packages/server/src/serve/manifest-scope-denial.sweep.test.ts
packages/server/src/serve/vault-plane.ts
packages/test-kit/src/year3-distributions.ts
packages/test-kit/src/year3-replica.ts
packages/vault/src/gateway/custody.ts
packages/vault/src/gateway/demo.ts
packages/vault/src/gateway/duties.ts
packages/vault/src/gateway/evidence.test.ts
packages/vault/src/gateway/evidence.ts
packages/vault/src/gateway/execution.ts
packages/vault/src/gateway/gateway.ts
packages/vault/src/gateway/locker-auth.ts
packages/vault/src/gateway/portability.ts
packages/vault/src/gateway/reseal.ts
packages/vault/src/gateway/search.ts
packages/vault/src/ingest/staging.ts
packages/vault/src/replica/parked.ts
packages/vault/src/schema/authority.ts
packages/vault/src/schema/entity-catalog.ts
packages/vault/src/schema/migrate.test.ts
packages/vault/tests/golden/issue-916/manifest.json
packages/vault/tests/golden/issue-916/vault.db.gz
scripts/docs-site/src/content/ontology-body.html
tests/quality/backup-corpus-fixture.ts
```

### Falsification

| claim at risk | throwaway check | result |
| --- | --- | --- |
| "Last used" is really the receipt chain's date, not a write-time guess | forced `writeAuthorityReceipt` to skip the upsert and re-ran `access-lens.test.ts` plus the vault suite | the lens test stays green (it feeds rows directly), which was the finding: the LENS cannot prove the stamp. The proof is the seam — one function, one transaction, one `authorityId` — and the vault suite is what would break if the two disagreed. Recorded as the weaker of the two claims |
| The dashboard really shows an undecided ask, rather than the harness drawing one | deleted the `requests` block from `SettingsAccessScreen` and re-ran the e2e spec | **red** on `getByText("Waiting on you")`; and `access-lens.test.ts` asserts a DECIDED request is dropped, so the block cannot fill with settled history |

## w5c — Locker's boundary, said accurately; and one runtime filter becomes SQL

Wave 5's Locker slice, plus the root's ruling that a declared row filter is not a WHERE clause. Serves in
part: **"Locker: sealed set, permits, reveal and `ONLINE_ONLY_ACTIONS` unchanged; its history query filters
in SQL; `locker-online-only.test.ts` green"**.

### Files

| file | change |
| --- | --- |
| `packages/blueprints/apps/locker/queries/access.ts` | header only: "THE ROW FILTER IS THE BOUNDARY" said the boundary was a grant's filter. It is now the app's own declared manifest carried as the execution clamp, and the `where` in the query is the inner wall — the header says both, and why the SQL filter is not redundant with the clamp |
| `packages/blueprints/apps/tally/queries/export.ts` | the revision read NAMES the exported expenses (`entity_id IN (…)`) instead of reading the newest 2 000 revisions of everything and discarding most — a window is not a filter |
| `packages/blueprints/apps/tally/queries/export.test.ts` | the ctx double honours `where`, so the clause is what the case proves rather than the handler's leftovers |

### Numbers

| measure | before | after |
| --- | --- | --- |
| revision rows the Tally export reads to ship N expenses' revisions | up to 2 000, of every entity type the clamp allows | **exactly the rows for those N expenses** |
| Locker sealed set / permits / reveal / `ONLINE_ONLY_ACTIONS` | — | **unchanged; no file under `gateway/{sealed,locker-auth,reseal}.ts` is in this diff** |

### Deleted, with its replacement

The export's post-read `.filter((row) => exported.has(row.entity_id))` → the `IN` clause that made it
unnecessary. Nothing else.

### Decisions

- **No user-visible change in this slice.** `check:ui-receipt` fires because both files sit under
  `packages/blueprints/apps/**`; the branch's `## User impact` and its screenshot belong to w4c, and this
  slice adds nothing to see: Locker's history renders the same rows in the same order, and the export ships
  the same revisions it always did. No screenshot is fabricated for it.

### Verification

```
git rev-parse HEAD^{tree}
bun run --cwd packages/blueprints typecheck                                    # passes
bun run --cwd packages/blueprints test -- --run apps/tally apps/locker         # 34 files, 661 passed
bun run --cwd packages/blueprints test -- --run src/locker-online-only.test.ts # 1 passed
bun run --cwd apps/mobile test -- --run src/lib/replica/locker-online-only.test.ts  # 3 passed
```

### Paths

```
packages/blueprints/apps/locker/queries/access.ts
packages/blueprints/apps/tally/queries/export.ts
packages/blueprints/apps/tally/queries/export.test.ts
```

### Falsification

| claim at risk | throwaway check | result |
| --- | --- | --- |
| The export's `IN` clause is what narrows the revisions, not a surviving JS filter | the test double previously ignored `where`; with the clause in and the double ignoring it, `ships only the revisions of the expenses that travel` was **red** (both revisions came back). The double now applies the clause and the case passes — so the assertion bites on the SQL | **red then green**, and the case cannot pass again on discarded leftovers |
| Locker's own walls really are untouched | `git diff origin/main -- packages/vault/src/gateway/{sealed,locker-auth,reseal}.ts packages/blueprints/apps/locker/actions` | `sealed.ts` and the actions are empty. `locker-auth.ts` and `reseal.ts` each carry ONE hunk from w4a and nothing else: `writeReceipt(db.audit, {grantId: null, purpose: "dpv:Security"})` → `writeAuthorityReceipt(db, {authorityId: null})`. Same receipt, same chain, no authority to stamp — the sealed set, the permits and the reveal path are not in the branch at all |

## w4/w5 lane close — what landed, and what wave 5 still owes

Two comments named columns of tables w4a deleted; both are corrected here. The rest of this section is the
lane's own account of what it did NOT land, so the next worker starts from state rather than from memory.

### Files

| file | change |
| --- | --- |
| `packages/vault/src/schema/core.ts` | the "no party column confers permission" list cited `access_grant.granted_by_party_id`; it now cites `share_authority.granted_by`, which is the column that exists |
| `packages/vault/src/schema/party-pointers.ts` | the RESTRICT roll-call cited `access_grant.*` and `access_scope_tombstone.grantee_party_id`; both tables are gone, and `share_authority.granted_by` already stood beside them |

### Acceptance clauses served by this branch

| clause | state |
| --- | --- |
| `evaluateAccess` has no `app` identity path; the app bridge issues no app credential; an owner-device read runs 0 grant statements | **served** (w4a, w4b) |
| the five grant tables and every reader are gone; `grep -r "dpv:" packages apps` empty | **served** — the only remaining mentions are `schema/access.ts`'s supersession marker and one test's pre-#928 replica fixture |
| `access_receipt` references `authority_id` from one id space; purpose column gone; chain verifier green; Settings → Access shows last-used for every row | **served** (w4a, w4c) |
| Locker: sealed set, permits, reveal, `ONLINE_ONLY_ACTIONS` unchanged; history filters in SQL; `locker-online-only.test.ts` green | **served** (w5c) |
| Companion attenuation and outbox grants are rows in the one plane; `grant_profile_json` has no reader | **NOT served** — see below |
| the give-plane coordinator, edge store, effects, edge routes and retire pass are deleted; a same-owner album move is one command | **NOT served** |
| a handler invocation's remaining reads commit once off the read path, with fsync-per-read measured (#922 B1) | **NOT served** — `Gateway.readBatch` exists (#916) and `push-wake-routes.ts` is its one caller; the app/agent bridge in `serve/vault-plane.ts` does not wrap a handler invocation's reads yet, and no before/after strace was taken |

### Findings — two design questions wave 5(a) cannot answer for itself

1. **`outbox_grant` has three actor kinds, and only one of them is an automation.** `outbox_item.actor_kind`
   is `identity.provAgentKind`, so a standing "always allow" rule can belong to the OWNER (a device caller)
   or, since w4b, to a first-party SURFACE — neither of which is an `automation` principal, and a surface is
   not a principal at all. The rule is also not a reach question: it is egress consent ("send this shape of
   thing to this address without asking again"), which `share_authority.verb`'s per-(kind × subject) registry
   has no vocabulary for. Options: (a) `principal_kind='automation'` for agent actors only, leaving owner and
   surface rules where they are — half a migration, and `outbox_grant` keeps a reader; (b) admit an `egress`
   subject_type across `device`/`automation` principals, with the surface as `subject_id`; (c) leave the
   outbox rule out of the one plane and say so in the issue. Recommendation: (b). Not landed — this is the
   root's ruling, not a worker's.
2. **Companion attenuation is read before a vault is open.** `devices.grant_profile_json` lives in the
   gateway's own store and `build-gateway.ts` reads it per request to authorize a companion. Making it a
   `share_authority` row puts a vault open on the companion authorization path, which changes what happens
   when the vault cannot be opened — today the companion is refused by the host, afterwards it would depend
   on the vault. That is a security-relevant failure-mode change and wants a ruling before the code.

### Verification

```
git rev-parse HEAD^{tree}
bun run --cwd packages/server test -- --run src/serve/authz-deny-matrix.test.ts src/serve/authz-matrix.smoke.test.ts src/serve/manifest-scope-denial.{sweep,fuzz,hostile,closed-grammar}.test.ts   # 6 files, 186 passed, 3 expected fail
bun run --cwd packages/vault test -- --run src/gateway/{access-properties,evidence,read-batch}.test.ts       # 3 files, 13 passed
```

### Paths

```
packages/vault/src/schema/core.ts
packages/vault/src/schema/party-pointers.ts
```

### Falsification

| claim at risk | throwaway check | result |
| --- | --- | --- |
| "No widening" is asserted, not assumed | ran the named invariant suites on the landed head: the deny matrix, the authz smoke matrix and all four automation clamp sweeps | **186 passed, 3 expected fail** — including `[law:consent-standing-answer-required]`, which asserts a `surface` identity's decision is byte-identical to the bare owner device's over the generated table × verb space |
| The five retired tables really have no reader left, rather than a reader the grep missed | `grep -rn 'access_grant\\b\|access_grant_scope\|access_policy\|access_scope_tombstone\|access_scope_request\|purpose_concept_id' packages apps` over non-test source | 5 hits before this commit, 3 after: `schema/access.ts`'s deliberate supersession marker and two comments — now one. No code path |

## w5a — the attenuations: companion surfaces and egress answers are rows

`outbox_grant` and `devices.grant_profile_json` are deleted. Both were real answers held outside the one
plane; both are now `share_authority` rows, and the one that is read before a vault can open keeps a
projection whose absence DENIES.

### Files

| file | change |
| --- | --- |
| `packages/vault/src/grant/egress-authority.ts` | new — the egress accessors over `share_authority` (`subject_type = 'egress'`, destination as subject, semantic verb as verb); `automation` principal for an `ai_agent` actor, `device` for the owner's surfaces |
| `packages/vault/src/grant/companion-surfaces.ts` | new — companion attenuation as `device`-principal rows over `app.surface`, verb `use`; a dropped surface revokes, an added one inserts |
| `packages/vault/src/grant/authority-registry.ts` | three triples: `device × app.surface × use`, and `device`/`automation × egress` (verbs closed by the connection contract, so the strategy is the enrichment gate) |
| `packages/vault/src/schema/outbox.ts` | `outbox_grant` deleted; `outbox_item.grant_id` → `authority_id REFERENCES share_authority(authority_id)`, index renamed |
| `packages/vault/src/schema/migrate.ts` | `SHARE_AUTHORITY_DDL` moves ahead of `OUTBOX_DDL` — the new reference is real |
| `packages/vault/src/schema/entity-catalog.ts` | `outbox.grant` removed from the registry |
| `packages/vault/src/commands/outbox.ts` | stage/decide/revoke read and write the authority row; output key `grant_id` → `authority_id` |
| `packages/vault/src/gateway/assistant-context.ts`, `packages/vault/src/index.ts` | the context sentence and the barrel follow |
| `packages/vault/src/gateway/evidence.test.ts` | `row.grant_id` → `row.authority_id` — a **pre-existing** typecheck red on `claude/928-w4` (w4a's rename) |
| `packages/server/src/serve/gateway-schema.ts` | `devices.grant_profile_json` → `attenuated INTEGER`; new `device_surface_projection(endpoint_id, vault_id, surfaces_json, projected_at)` |
| `packages/server/src/serve/enrollment-store.ts` | `grantProfile` → `attenuated` + `projectedSurfaces` / `projectSurfaces` / `attenuatedEndpointsFor`; revoke and vault removal clear the projection |
| `packages/server/src/serve/companion-access.ts` | the whole boundary: `projectCompanionAttenuation`, `recordCompanionAttenuation`, and `companionAccess` — one decision with `unreadable` as a case |
| `packages/server/src/serve/build-gateway.ts` | the request path reads the projection; re-projects on boot and on every `onMount` |
| `packages/server/src/cli/endpoint-host.ts` | pairing writes the authority rows into each enrolled vault, then projects |
| `packages/server/src/serve/vault-plane.ts`, `vault-quarantine.ts` | outbox grant readers → the egress accessors; the review feed's `authorityId` is now one id space |
| `packages/server/src/serve/vault-context.ts`, `routes/vault-routes.ts`, `routes/devices-routes.ts`, `routes/companion-grants.ts` | `grantProfile` → `companionSurfaces`; the devices DTO keeps its wire name, filled from the projection |
| `SECURITY.md`, `docs/decisions.md`, `docs/glossary.md`, `docs/vault-ontology.md`, `tests/onboarding-scenarios.md` | AP-egress-rows and AP-companion-projection recorded with their property; V-split's companion sentence marked superseded; ONT-20 closed; four sentences that named the deleted column |
| tests | `packages/vault/src/grant/egress-authority.test.ts` (new), `packages/vault/src/commands/outbox.test.ts`, `packages/server/src/serve/companion-access.test.ts`, `device-plane.test.ts`, `vault-quarantine.test.ts`, `packages/server/src/automation/fire/enrich-gate.test.ts`, `packages/server/src/backup/backup.integration.test.ts`, `recover.integration.test.ts` |

### Decisions

- **The gateway keeps a PROJECTION, not the answer.** Root ruling: the rows are the source of truth; the
  pre-open request path reads a `gateway.db` projection rebuilt on vault mount and on every write of the
  answer. An attenuated device with no projection is **refused** (`companion_attenuation_unavailable`),
  never widened — which is why `devices` keeps one `attenuated` flag: the fact the boundary needs before
  any vault is open is "is this device confined", not "to what".
- **The wire keeps `grantProfile`.** The pairing request and the devices DTO keep the field name; renaming
  them reaches `packages/client`, `apps/mobile` and `packages/tunnel` for no model gain. Doc debt below.
- **`outbox.revoke_grant` keeps its command name** (its input is now `authority_id`). Renaming the command
  and the `/outbox/grants` route would ripple into mobile for a vocabulary gain alone.

### Verification

```
git rev-parse HEAD^{tree}
bun run --cwd packages/vault typecheck && bun run --cwd packages/server typecheck
bun run --cwd packages/vault test -- --run src/commands/outbox.test.ts src/grant/egress-authority.test.ts src/grant/authority-registry.test.ts src/schema/{migrate,ontology-shape,atlas-census}.test.ts
bun run --cwd packages/server test -- --run src/serve/{authz-deny-matrix,authz-matrix.smoke,vault-quarantine,companion-access,device-plane}.test.ts src/routes/{enrich-search-routes,devices-routes}.test.ts src/automation/fire/enrich-gate.test.ts
bun run lint && bun run lint:vault-sql
```

### Findings

- `packages/vault/src/gateway/evidence.test.ts` did not compile on `claude/928-w4` (`row.grant_id` after
  w4a renamed the column). Fixed here; the base's typecheck was red before this lane touched it.

### Falsification

| claim at risk | throwaway check | result |
| --- | --- | --- |
| "A missing projection denies" is asserted, not built | `companionAccess({attenuated:true, projected:undefined})` in `companion-access.test.ts`, plus reading the one call site in `build-gateway.ts`: the `unreadable` case returns 403 before the header is ever set | **holds** — and `projectedSurfaces` returns `undefined` (not `[]`) for an absent row, so the two are distinguishable |
| `grant_profile_json` / `outbox_grant` really have no reader | `grep -rn 'grant_profile_json\|outbox_grant' packages apps docs tests SECURITY.md` outside receipts/CHANGELOG | **no code hit** — every survivor is a register/supersession row naming the deleted store as history. The surviving `grantProfile` identifiers are the pairing wire field and the devices DTO, both fed from the projection |

## w5b — the give-plane residue is deleted; a placement is one call

`share_edges`, `share_effects` and the machinery around them served one act: moving or copying a set of
items between two of the owner's OWN vaults, with both vaults open in the same process. That is not a
distributed obligation, so the edge row, the reducer, the effect outbox, the executor, the local
reconciler, the retry sweep and the retirement pass are gone.

### Files

| file | change |
| --- | --- |
| `packages/vault/src/share/placement.ts` | `placeItemsInVault` — grant the placement authority, project, then release the source; `moveOutOfVault` (one item, one transaction each) becomes `moveItemsOutOfVault` (the whole set, ONE transaction) |
| `packages/server/src/routes/placement-routes.ts` | replaces `routes/edges-routes.ts`: the same path and wire, one synchronous vault call, `share_access_receipts` as the exactly-once anchor; a vault not open here is a retryable `503 vault_not_open`, a failed placement a `502` that audits nothing |
| `packages/server/src/serve/share-access-receipts.ts` | gains `placement_kind` / `created_by_device` and the two readers the route lists and replays from; ids are parsed, never cast |
| `packages/server/src/serve/gateway-schema.ts` | `share_edges` and `share_effects` deleted with their indexes; `share_access_receipts` kept as history |
| `packages/server/src/serve/peer-plane-sweep.ts` | the effect drain leaves the tick; commons + route re-announcement remain (and `db` / `vaultFor` / `partyIdFor` leave its options) |
| `packages/server/src/serve/gateway-db.ts` | the once-per-file retirement drain is gone with the queue |
| deleted | `serve/share-coordinator.ts` (+test), `share-edge-row.ts`, `share-edge-store.ts`, `share-effects.ts`, `share-effect-executor.ts`, `share-effects-retire.ts`, `share-outbox-obligation.contract.test.ts`, `share-receipt-authority.contract.test.ts`, `routes/edges-reconcile.ts`, `routes/edges-routes.ts` |
| `packages/server/src/serve/build-gateway.ts`, `src/index.ts` | route + sweep wiring |
| `scripts/lint-vault-sql.mjs` | five allowlist entries for deleted files removed (`allow-toolchain-config`) |
| `tests/claims.json`, `tests/floors.json` | `share-receipt-authority` re-homed to `routes/placement-routes.test.ts`; `share-outbox-obligation` replaced one-to-one by `same-owner-placement` (floor 4 → 4) |
| `tests/inventory.json` | pins for the six added files, pins for the twelve deleted files removed, `companion-access.ts` hand-raised (see Decisions) |
| tests | `packages/vault/src/share/placement-move.test.ts` (new), `placement.test.ts`, `routes/placement-routes.test.ts`, `serve/peer-plane-sweep.test.ts`, `gateway-db.test.ts`, `vault-links-store.test.ts`, `peer-transport-remote.test.ts`, `vault-plane-commons.test.ts` |
| docs | `ARCHITECTURE.md`, `docs/decisions.md` (the drained-obligation ruling marked superseded), `docs/glossary.md` (**edge** → **placement**), `docs/vault-ontology.md` ONT-21 closed, `apps/desktop/tests/e2e/fixtures.ts` comments |

### Decisions

- **The route path and wire stay.** `POST/GET /centraid/_gateway/edges` keeps its shape so the phone's
  placement outbox, `centraid-inline.ts` and the desktop e2e fixture are untouched; only the module and
  the machinery behind it change. `status` is always `completed`, because a placement that did not
  complete leaves no history row and the caller learns that from the HTTP status.
- **Retry moved to the caller that already had it.** The phone's placement outbox is the durable queue;
  the gateway-side outbox was a second one. A vault not open here is now `503`, which that outbox retries.
- **`share-outbox-obligation` is replaced, not dropped.** `same-owner-placement` (floor 4, unchanged)
  carries the durability claim in its new home; the full rationale is in `tests/claims.json`.
- **`companion-access.ts`'s density pin is hand-raised** 23.76% → 28.41% (`[245,1031]` → `[963,3390]`):
  the file grew from a single request predicate to the whole Companion boundary, and its header is the
  argument for why a missing projection denies. The comments were cut back once before re-pinning.

### Verification

```
git rev-parse HEAD^{tree}
bun run --cwd packages/vault typecheck && bun run --cwd packages/server typecheck
bun run --cwd packages/vault test -- --run src/share/ src/grant/
bun run --cwd packages/server test -- --run src/routes/placement-routes.test.ts src/serve/{peer-plane-sweep,gateway-db,vault-links-store}.test.ts
bun run lint && bun run lint:vault-sql && bun run lint:ledgers
grep -rn 'share_edges\|share_effects' packages apps docs   # register rows only
```

### Paths

```
packages/server/src/backup/recover.integration.test.ts
packages/server/src/routes/devices-routes.ts
packages/server/src/serve/device-plane.test.ts
packages/server/src/serve/vault-quarantine.ts
packages/server/src/serve/vault-quarantine.test.ts
```

### Findings

- **`bun run test:comment-density` is red on `claude/928-w4` before this lane**: 569 pinned files measure
  above their pin on the committed base tree (`git stash && bun run test:comment-density` → 569). Not
  chased here; the root owns whether the branch re-pins wholesale or the rises are real.
- **`bun run lint:ledgers` reports eleven `tests/journeys.json` removals against `origin/main`** that this
  lane did not make (`git diff HEAD -- tests/journeys.json` is empty) — base lag, per the slice contract.

### Falsification

| claim at risk | throwaway check | result |
| --- | --- | --- |
| "One call" is a rename, not a real collapse | read the new POST path end to end: no `share_edges` row is written, no effect enqueued, no sweep involved — and `grep -rn 'share_edges\|share_effects' packages apps` over code is empty | **holds** — the only survivors are register rows in `docs/` naming the deleted tables as history |
| A move now half-completes where it used to resume | `moveItemsOutOfVault` opens ONE `BEGIN IMMEDIATE` over the whole set (it used to be one per item), and the album test asserts both photographs and the collection left together while the destination holds all of it | **holds** — the crash window narrowed rather than widened; the projection still commits before any release |

## Follow-up — CI repair

### What changed

- packages/model-runtime/automation-handlers/embed-image.js, packages/model-runtime/automation-handlers/embed-text.js, packages/model-runtime/automation-handlers/faces.js, packages/model-runtime/automation-handlers/photo-ocr.js, packages/model-runtime/automation-handlers/place-names.js, and packages/model-runtime/automation-handlers/transcript.js now match the purpose-free recognition handler contract at every vault call.
- The six generated bundles were rebuilt: packages/blueprints/automations/embed-image/automations/embed-image/handler.js, packages/blueprints/automations/embed-text/automations/embed-text/handler.js, packages/blueprints/automations/faces/automations/faces/handler.js, packages/blueprints/automations/photo-ocr/automations/photo-ocr/handler.js, packages/blueprints/automations/place-names/automations/place-names/handler.js, and packages/blueprints/automations/transcript/automations/transcript/handler.js.
- tests/quality/chaos-planner-app.ts and tests/quality/component-chaos-world.ts register the planner's declared app scope through recordAppInstall, including after a synthetic gateway restart.
- tests/quality/offline-reconnect.integration.test.ts, tests/scale/replica-bootstrap.scale.test.ts, tests/scale/replica-reconnect.scale.test.ts, tests/scale/replica-sse-fanout.scale.test.ts, and tests/scale/large-vault.scale.test.ts follow the retired app-grant and purpose-free test APIs.
- packages/server/src/serve/vault-plane.ts and packages/vault/src/commands/provider-writeback.ts read and insert the renamed outbox_item.authority_id column; packages/server/src/serve/outbox-executor.test.ts follows the authority_id output contract.
- scripts/lint-engine-conformance.mjs follows the action kit's removed ACTION_PURPOSE export. tests/quality/classification-ratchet.json re-pins the changed manifest and claims fingerprints; thresholds and classifications are unchanged.

### Verification

```sh
bun run --cwd packages/model-runtime test -- automation-handlers/embed-image.test.ts
bun run --cwd packages/model-runtime build:automations
bun run typecheck
bun run lint:product
bun run scripts:test
```

### Decisions

- #928 re-pins classification fingerprints after the authority-plane migration changed the governed manifest and claim statements; thresholds and classifications are unchanged.

### Audit

Verdict: PASS. The follow-up diff is limited to restoring the purpose-free recognition calls, migrating synthetic and scale fixtures to recordAppInstall, rebuilding their committed bundles, and updating the conformance/fingerprint ledgers required by those changes. The affected unit, quality, typecheck, product-gate, and script suites are recorded above.

- Post-rebase verification: `tests/quality/classification-ratchet.json` was re-pinned to the current `tests/claims.json` digest after the PR branch's placement refactor; `bun run lint:product` passed all 42 gates.
- Post-main-sync verification: `tests/integration-mobile/lib/write-conditions.ts` and `tests/integration-mobile/denied.integration.test.ts` now assert first-party app withdrawal through installation state (`appRevoked`), not standing grant count; `bun run test:integration:mobile -- --run tests/integration-mobile/denied.integration.test.ts` passed 8/8.

- Post-CI verification: `check:reachability` found the retired `parseEdgeScope` and `parseTargetItemIds` exports had only test callers. They were deleted with their obsolete tests from `packages/server/src/serve/share-scope.ts` and `packages/server/src/serve/share-scope.test.ts`; `validateItemIds` remains the production placement boundary. `bun run check:reachability` passed with 363 capabilities across 21 module globs, `format:check` passed, the focused server test passed 6/6, and `bun run typecheck` passed all 25 tasks.

- Post-CI verification: the PR `verify` lane caught the work-counter expectation left behind by the owner-direct read change: the measured read cost was `statements=3`, `rowsScanned=23`, `fsyncs=0`, `bytesRead=2028`, `bytesWritten=0`, while the old budget still required one audit fsync. The expectation now records those tighter values and documents the zero-barrier invariant; `bun run test:perf:counters` passed locally after the update.

- Post-CI verification: coverage shard 3 caught the `issue-916` golden corpus and ontology page still naming retired `outbox_grant` machinery after the authority-plane schema landed. Re-froze `packages/vault/tests/golden/issue-916` with `bun run --cwd packages/vault build && bun run golden-vault:freeze -- --label issue-916`, removed `grant` from the ontology outbox band, and ran `bun run --cwd packages/vault test -- --run src/golden-vault.test.ts src/schema/ontology-doc.test.ts` — 15/15 passed.

- Post-CI verification: SonarCloud reported two reliability findings on new code: the `scopeForSubject` method reference passed directly to `.map()` and a redundant `| undefined` on optional `ScopeTriple.table`. The map now uses an explicit subject callback and the optional property uses the canonical form; the focused authority-request and vault-plane tests passed 14/14, and both package typechecks passed.
