# issue-805 — Crisp UX copy: rulebook, ratchet, shared seam, full audit

GitHub issue: [#805](https://github.com/srikanth235/centraid/issues/805)

One umbrella, one receipt, orchestrated slices. The app's copy was verbose in
one systemic way — state the fact, then reassure about what was NOT lost. This
umbrella lands the binding rulebook (DESIGN.md § Copy), a tighten-only
length/sentence/filler ratchet, one canonical home per shared string, and a
full audit of every user-facing string. Slices execute per
[docs/multi-agent.md](../docs/multi-agent.md): the root agent holds the plan
and cross-slice invariants; sub-agents work file-disjoint slices.

## Checklist

- [x] A — the rulebook
- [x] B — the ratchet
- [ ] C — the shared copy seam
- [ ] D1 — audit: client shell + Settings + Onboarding
- [ ] D2 — audit: blueprints Photos
- [ ] D3 — audit: blueprints Docs + Notes + remaining apps
- [ ] D4 — audit: mobile screens + kit
- [ ] D5 — audit: server-surfaced strings + desktop/web/extension shells
- [ ] design-divergences register updated for any slice-kept divergence

## What changed

### Slice A — the rulebook (2026-08-16)

- `DESIGN.md` — new `## Copy` section between `## Components` and
  `## Responsive Behavior`: voice definition, per-surface budget table,
  reassurance placement rule, banned filler, four worked before/after pairs
  drawn from real strings. Copy guidance folded into `## Agent Prompt Guide`
  and `## Do's and Don'ts`; issue + ratchet paths added to References.
- `docs/decisions.md` — new `## Copy governance (#805)` section with rulings
  U-voice / U-ratchet / U-scope / U-reassurance / U-umbrella.
- `docs/glossary.md` — the "broader prose and dynamic copy remain judgment"
  concession now splits word choice (glossary) from length (DESIGN.md § Copy).
- `AGENTS.md` — umbrella bullet now states: one umbrella issue, no child
  issues — slices are sub-agents and PR waves under it, one receipt.
  (`CLAUDE.md` is a symlink to `AGENTS.md`.)
- `packages/design/src/design-md.test.ts` — canonical `##` section list gains
  `Copy` (the test pins DESIGN.md's section inventory).

### Slice B — the ratchet (2026-08-16)

- `tests/quality/user-facing-qualities.test.ts` — new U4 test: walks
  user-facing sources (`packages/client/src`, `packages/blueprints/apps`,
  `apps/mobile/src`, `apps/desktop/src`, `apps/web/src`, `apps/extension/src`,
  `packages/design/src` minus `roles.ts`, `packages/server/src/routes`),
  extracts prose string literals, and flags any that exceed ~120 chars,
  contain ≥ 2 sentences, or match the banned-filler regex. Stale allowlist
  entries are themselves violations, so seeds cannot outlive the copy they
  excuse.
- `tests/quality/copy-allowlist.json` — new `copyRatchet` key seeded with 255
  current offenders (D1 83 · D2 21 · D3 40 · D4 95 · D5 16), each with a
  slice-tagged reason; consent-surface seeds carry a consent reason so the
  disclosure survives its rewrite. Tighten-only: `maxEntries` in the JSON and
  a matching ceiling constant in the owning test both cap growth; audit
  slices lower them together as they drain seeds.

## Decisions

- The U4 scanner skips template literals containing `${…}` — a spliced value
  cannot be length-judged from source. Interpolated verbose strings are still
  caught by the audit slices (judgment pass), just not mechanically.
- `packages/server/src` is walked only at `src/routes/**` — the route layer is
  where the gateway mints strings the shell renders verbatim. The rest of the
  server tree (engine, automation, acp, serve, cli, …) is logs, protocol and
  internal diagnostics this literal-level walk cannot distinguish from
  member-facing copy; widening would trade precision for noise. Boundary
  stated here per issue B3.
- U4 is not registered as a `tests/matrix.json` gate in this wave: the A1
  gate-registry test validates declared gates but does not require every test
  to declare one, and registering would ripple into
  `classification-ratchet.json` fingerprints. Can be promoted later without
  changing the test's behavior.
- `packages/design/src/roles.ts` token rationales are developer-facing
  (per the issue's non-goals) and excluded from the walk.

## Out of scope

Per the issue's non-goals: no i18n framework, no new lint infrastructure, no
churn on compliant strings, no tone flattening of consent/destructive/security
copy, no copy changes to developer-facing prose.

## Verification

Slice A + B (root re-ran after integration):

```sh
bun run lint:design-md               # errors: 0 (87 pre-existing orphaned-token warnings)
bunx vitest run packages/design/src/design-md.test.ts   # 15 passed
bun run test:qualities               # 24 passed, incl. new U4 (green, seeded)
bunx tsc -p tests                    # clean
```

Demonstrated red for U4: appending a >120-char two-sentence "Please…" string
to `packages/client/src/home-copy.ts` fails U4 with
`unallowed length+sentences+filler …`; suffixing an allowlist literal fails
with `stale … (no longer in the source)`. Both reverted.

## Audit counts (workstream D contract)

Per-slice audited / rewritten / allowlisted counts land here as D slices
complete.

| Slice | Audited | Rewritten | Allowlisted (reason) |
| --- | --- | --- | --- |
| D1 | — | — | — |
| D2 | — | — | — |
| D3 | — | — | — |
| D4 | — | — | — |
| D5 | — | — | — |

## Audit

Slice A and B (rulebook and ratchet) verified by an independent fresh-context
sub-agent against `git diff --cached`, this receipt, and issue #805. All three
audit criteria pass.

### 1. "What changed" describes the diff faithfully — **PASS**

Slice A files present:

```sh
git diff --cached --stat | grep -E "AGENTS.md|DESIGN.md|decisions.md|glossary.md|design-md.test.ts"
# AGENTS.md 2 ± · DESIGN.md 45 ± · docs/decisions.md +14 · docs/glossary.md 2 ±
# packages/design/src/design-md.test.ts +1
```

- DESIGN.md: Copy section present between Components and Responsive Behavior;
  budget table, reassurance rule, banned-filler list, and 4 worked pairs
  verified.
- docs/decisions.md: Copy governance section with 5 U-rulings verified.
- docs/glossary.md: concession split — judgment on **word choice**, not on
  **length** — cross-linked to DESIGN.md § Copy.
- AGENTS.md: umbrella bullet carries the one-issue/no-child-issues sentence.
- design-md.test.ts: Copy added to the canonical section list.

Slice B files present; seed breakdown re-measured from the staged tree:

```sh
git diff --cached tests/quality/copy-allowlist.json | grep '"reason":' | grep -o 'D[1-5]' | sort | uniq -c
#  83 D1 · 21 D2 · 40 D3 · 95 D4 · 16 D5   (total 255 — matches receipt)
```

U4 walks the COPY_SCOPE paths, flags >120 chars / ≥2 sentences / banned
filler, prunes stale entries, and caps growth via maxEntries + in-test
ceiling.

### 2. Each `[x]` Checklist item is realized in the diff — **PASS**

A (rulebook): all five components present as described. B (ratchet): U4 test +
255 slice-tagged seeds + tighten-only ceiling + stale-entry detection
verified.

### 3. Checklist mirrors the issue's checklist — **PASS**

Issue #805 execution-order checkboxes map to the receipt checklist: A and B
checked; C and D1–D5 unchecked as expected for the first wave; the
design-divergences item mirrors the issue's final checkbox.

## Session

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-16 | claude-code | dbac2544-ca99-517e-8544-865eb760845c |
