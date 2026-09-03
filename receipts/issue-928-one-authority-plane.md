# Issue #928 — one authority plane: retire the app grant evaluator; first-party apps are not principals

Umbrella receipt. One receipt for the whole umbrella; each wave appends its own section.

## Checklist

- [ ] `evaluateAccess` has no `app` identity path; the app bridge issues no app credential; an owner-device read of the owner's vault runs 0 grant statements
- [ ] Replica shapes are composed statically from the app manifest and the sealed registry; shape ids for all eight apps are unchanged on the golden vault; a sealed column name appears in no shape
- [ ] The static tripwire fails a build in which an app query touches an undeclared entity (proven with a seeded violation)
- [ ] `access_grant`, `access_grant_scope`, `access_policy`, `access_scope_tombstone`, `access_scope_request` and every reader of them are gone; `grep -r "dpv:" packages apps` is empty outside receipts and CHANGELOG
- [ ] Every automation's standing answer is a `share_authority` row with `principal_kind = 'automation'`; the owner's prior refusals survive as `declined` rows (count and content asserted by the migration test); a widened manifest still parks
- [ ] The assistant holds no standing grant; its reads and writes are receipted exercises on behalf of the acting owner; scheduler-fired automations are capped by their row
- [ ] `access_receipt` references `authority_id` from one id space; the purpose column is gone; the chain verifier is green; Settings → Access shows last-used for every row
- [ ] Companion attenuation and outbox grants are rows in the one plane; `grant_profile_json` has no reader
- [ ] The give-plane coordinator, edge store, effects, edge routes and retire pass are deleted; moving an album between two of the owner's vaults is one command
- [ ] Locker: sealed set, permits, reveal and `ONLINE_ONLY_ACTIONS` unchanged; its history query filters in SQL; `locker-online-only.test.ts` green
- [ ] Authz deny matrix, automation clamp sweeps and the harness parity integration test green at every slice exit
- [ ] `docs/decisions.md`, SECURITY.md and `docs/vault-ontology.md` state the model above; the drift register rows for the consent plane are closed

Nothing is ticked. Wave 1a writes the rulings only; every criterion above needs code, and the last one needs both halves — the three docs state the model now, but the drift register rows are **open**, not closed, so the item stays unticked until the waves that close them land.

## What changed

Wave 1a is docs-only. It records the rulings #928 makes as current state, so later waves are built over a written answer rather than a guess.

- **`docs/decisions.md`** — new section `## One authority plane (#928)`, placed immediately before `## Related docs`: the four principal kinds with where each is enforced; eight rulings `AP-principals`, `AP-apps-declare`, `AP-owner-direct`, `AP-automation-principal`, `AP-one-id-space`, `AP-attenuations`, `AP-give-residue`, `AP-locker-boundary` stating A1–A7 of the issue as current decisions; the v0 delete-with-replacement stance; the two open questions the root adopted (third-party apps → `app` stays reserved and unwritten; a scheduler-fired automation's principal → one row per automation, not per pack) and the two left open by design (`sqlAsOwner` in wave 3, owner-direct read receipts with #922 B1). Below it, `### The rulings, re-judged (#928)` reproduces the issue's register as a table of Seam | Ruling cited | Property that depends on it now | Verdict — thirteen rows, ten findings, two kept-and-re-homed with the property named, one "holds" row for the spine. No row says "deliberate", and no row is kept without a property.
- **`docs/decisions.md`** — five rows added to `## Superseded decision pointers`: #306 "installing is the consent", #883 V-split's app carve-out, #873 L-access's "the rowFilter is the boundary", #308's tombstones and scope requests (re-homed as `declined` rows for automations), and the assistant's standing `act` grant. Each names #928 and its replacement. The existing `V-split` row in the Grants v2 table gains one appended sentence marking it superseded in part; no other existing text is rewritten.
- **`SECURITY.md`** — the five-layer bullet now says L2 is closed by #928 and carries a second bullet with the four principal kinds and their enforcement points, stating plainly that a first-party app is not a principal and that its reach is fixed at build time by a declared entity manifest plus a static tripwire. The agents bullet's admission that scheduler-fired automations run uncapped is marked **closed by #928 A3** — they act under an explicit `automation` row — with the wave that lands it named. The threat table's `Consent` row is rewritten the same way. L4 attribution keeps its "scheduler-fired automations carry none" admission, now dated — it holds "until their `automation` row lands in #928 wave 3" — because attribution today is unchanged; and "the journal records" becomes "the audit band records", the current name since #916. Every sentence that would claim code not yet landed says instead which wave lands it. No other SECURITY.md sentence changed.
- **`docs/vault-ontology.md`** — six rows added to `## Drift register`, each `open — closes in #928 wave N` with the mechanism named: **ONT-16** the app grant tables, **ONT-17** purposes and the DPV vocabulary, **ONT-18** `access_policy` and its two consultations per non-owner read, **ONT-19** the receipt's four id spaces, **ONT-20** `grant_profile_json` and `outbox_grant`, **ONT-21** the give-plane residue. No row is closed by this slice.
- **`docs/glossary.md`** — `principal` gains `automation` and states the clamp as its locus; new entries define **automation** (principal kind), **app** (reserved principal kind), **authority_id** and **owner-direct read**; the `consent / grant` entry stops calling app grants strategy machinery beneath manifests; two rows in the broader forbidden-synonyms table retire "purpose" / `dpv:` and "app grant" / "consent-scoped app handler", each pointing at #928. Every entry whose sentence would describe code that has not landed names the wave that lands it (the `automation` kind in waves 1 and 3, `authority_id` in wave 4, the app credential in wave 2), and the same wave-naming was added to the #873 supersession row.
- **`receipts/issue-928-one-authority-plane.md`** — this file, created as the umbrella receipt.

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
| 2026-09-03 | claude-code | 60f9e86b-149f-5fc9-84c0-f2160b6b6f3c |

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
