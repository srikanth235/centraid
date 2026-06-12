# Issue #243 — docs: restyle README + fix post-#220 mode/prefix drift

GitHub issue: [#243](https://github.com/srikanth235/centraid/issues/243)

The root README still led with a dense architecture paragraph, and a re-audit
of the docs site after the #220 overhaul surfaced four stale spots that
predate the standalone daemon or the dropped `auto.*` template-id prefix.

## Checklist

- [x] Restyled README.md into a scannable quick-start shape
- [x] Re-audited the docs site after the post-#220 commits
- [x] Fixed the remaining two-modes and auto-prefix stragglers
- [x] Amended the gateway/handler directives' rationale to "three hosts"
- [x] Verified the docs build and smoke pass

## What changed

**Restyled README.md into a scannable quick-start shape.** Rewrote the root
README from an architecture-first paragraph into a brief, scannable layout
modeled on well-regarded OSS READMEs: a one-line value proposition, a "What it
does" bullet list, a "How it works (30 seconds)" ASCII diagram, "Get started
(60 seconds)" commands for both the desktop embed and the `centraid-gateway`
daemon, the package layout table, verified proof numbers (87 vitest files, 59
Playwright e2e tests across 14 scenario sections, 9 packages + 2 apps), and a
documentation table deferring detail to `docs/`.

**Re-audited the docs site after the post-#220 commits** (#222, #141, #226,
#228, #230, #239, governance-kit 0.6.0). All 35 `.mdx` pages re-checked
against source. The overhaul held up — the post-#220 commits were mostly
desktop-UI and test-infrastructure changes the docs deliberately don't
describe, and the #141 templates-route display fields were already
documented in `docs/templates/index.mdx`.

**Fixed the remaining two-modes and auto-prefix stragglers** the re-audit
surfaced:

- `docs/index.mdx` still said "the bundled `auto.*` templates" — template ids
  are plain slugs since the manifest `kind` field replaced the prefix
  (`docs/concepts/apps.mdx`, `docs/templates/index.mdx`,
  `packages/blueprints/manifest.json` all agree) — and its "Run anywhere"
  bullet listed only two run modes.
- `docs/getting-started.mdx` said "the two modes share one
  upload-and-version-flip contract".
- `docs/concepts/architecture.mdx` opened with "one product wearing two
  shapes" while its own comparison table three lines down has three columns.

All four spots now name the three hosts: desktop embed, `centraid-gateway`
daemon, OpenClaw plugin.

**Amended the gateway/handler directives' rationale to "three hosts"**
(second commit). Both `gateway-engine-mode-agnostic` and
`handler-uses-ctx-primitives` carried a "same code, two modes" rationale that
predates the standalone daemon. Reworded to "same code, three hosts" through
the governance skill's `directive modify` flow (the `srikanth235/centraid`
pack is `source: local`, so `directive *` owns it directly). Touched the
directive folders (`constitution.md`, `directive.yaml`, and the gateway
`check.sh` comment), the mirrored subsections in `CONSTITUTION.md`, and the
doc quote at `docs/reference/governance-directives.mdx` line 58. The rules
themselves (detection regexes, forbidden-identifier and SDK-import lists,
entrypoints, waivers) are unchanged — rationale text only. Appended an
Evolution Log entry dated 2026-06-13. The gateway directive's scope
enumeration was widened from "embedded vs OpenClaw plugin" to name the daemon
as the third host so it reads coherently with "three hosts."

## Decisions

- **`docs/reference/governance-directives.mdx` line 58 was fixed in the
  second commit, not the first.** It quotes the `gateway-engine-mode-agnostic`
  directive's constitution text verbatim, so fixing the doc alone would have
  diverged it from its kit-managed source. The directive itself was amended
  first (via `directive modify`), and the doc updated to match in the same
  commit — keeping quote and source in lockstep.
- **Used `directive modify`, not a hand-edit, for the pack files.** The
  directive folders under `.governance/packs/srikanth235/centraid/` are
  kit-managed; the governance skill routes `local`-pack edits through the
  pinned kit's amend flow, which keeps the directive triple + `CONSTITUTION.md`
  + Evolution Log atomic. No lockfile mutation (a modify keeps the directive
  ids unchanged).
- **First attempt extended the frozen `issue-120` receipt** — blocked by
  `doc-integrity` (receipts are immutable once on the default branch) and by
  `receipt-per-issue` rule 1 (no two receipts share an issue number), so this
  work got its own issue (#243) and this receipt instead.
- README proof numbers are stated as point-in-time counts, not promises; the
  e2e numbers are taken from the e2e suite's own README rather than a fresh
  grep (raw `grep -c 'test('` over-counts `test.describe` blocks).

## Out of scope

- The historical Evolution Log entry (2026-05-26) and the README/architecture
  prose still contain the phrase "two modes" only where it is a frozen
  audit-trail line — left intact by design; the new log entry records the
  reword.
- The desktop UI surfaces themselves are still deliberately undocumented in
  the docs site; nothing added for #222/#230/#239 beyond confirming no doc
  contradicts them.

## Verification

```sh
bun run docs:build   # 38 pages indexed, no errors
bun run docs:smoke   # docs smoke ok
```

Verified the docs build and smoke pass with the edits in place. README proof
numbers verified against the tree:

```sh
find packages apps -name '*.test.ts' -not -path '*/node_modules/*' | wc -l   # 87
ls packages | wc -l                                                          # 9
```

E2e counts (59 tests, 14 scenario sections) sourced from
`apps/desktop/tests/e2e/README.md`. Template-id claim verified against
`packages/blueprints/manifest.json` (ids `briefing`, `email-triage`, … — no
`auto.` prefix).

Directive amendment (second commit) — both modified directives still pass
their own checks after the reword, and no stale phrasing remains in the
directive/constitution/doc bodies:

```sh
bash .governance/run.sh gateway-engine-mode-agnostic   # ✓ passed
bash .governance/run.sh handler-uses-ctx-primitives    # ✓ passed
grep -rn -i 'two modes' .governance/packs/srikanth235 docs/reference/governance-directives.mdx
# (only the frozen Evolution Log audit line remains, by design)
```
