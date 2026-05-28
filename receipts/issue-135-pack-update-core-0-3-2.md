# issue-135 — pack update governance-kit/core 0.3.1 → 0.3.2

GitHub issue: [#135](https://github.com/srikanth235/centraid/issues/135)

## Checklist

- [x] Core pack re-pinned to upstream SHA `ff76a282`
- [x] Lockfile upserted via `packverb lock-add`
- [x] New directive: `workflows-hardened`
- [x] Substantive existing-directive changes — macOS UTF-8 commit-subject fix
- [x] Cosmetic existing-directive changes — added install-assets
- [x] Hook dispatchers intentionally not regenerated

## What changed

**Core pack re-pinned to upstream SHA `ff76a282`.** Lockfile upserted via `packverb lock-add` — the prior `0.3.1 / 2a18ad43` entry was replaced atomically by pack id. The lockfile now records `governance-kit/core` at `version: 0.3.2`, ref `gh:Duaility/governance-kit/packs/core@main`, sha `ff76a2827e8653f4998817d7b654f4735c2cdfa5`, `min_governance_kit: 0.3`, with the 14-directive list now including `workflows-hardened`.

**New directive: `workflows-hardened`.** Upstream 0.3.2 promotes `workflows-hardened` into the `minimal` preset, so unlike the 0.3.1 upgrade (where it was skipped explicitly) this update installs it. The directive enforces two GitHub-Actions hardening checks on pre-commit:

1. Every workflow file declares a `permissions:` block (top-level or per-job) for least-privilege.
2. Every third-party action (outside the `actions/*` and `github/*` namespaces) is pinned to a 40-char commit SHA, not a moving tag.

Rationale upstream cites the 2025 tj-actions/changed-files compromise — tag-pinning was the gap that exploit walked through. Dry-run against the repo's three workflows (`.github/workflows/ci.yml`, `docs.yml`, `governance.yml`) passes before install. Hook discovery is runtime-driven, so the new directive is picked up by the existing `.githooks/pre-commit` dispatcher without regeneration (see preservation note below).

**Substantive existing-directive changes — macOS UTF-8 commit-subject fix.** Two directives ship the same upstream bugfix (Duaility/governance-kit#140):

- `agent-steering-accounting`
- `agent-token-accounting`

Both `hooks/pre-commit.sh` files previously read the parent git process's argv via `ps -ww -p $pid -o args=` on macOS. Under `LC_ALL=C` (the locale git hooks typically run with), `ps` cat-v-escapes every byte ≥ 0x80, which mangled UTF-8 multi-byte sequences in commit subjects before the `(#N)` regex saw them — so non-ASCII commits silently failed inference even when the subject was well-formed. Both directives now add a `lib/argv.py` helper that reads `KERN_PROCARGS2` via `sysctl(3)` (ctypes-only, stdlib, no third-party deps) and the hook falls back to it on Darwin. Linux's `/proc/<pid>/cmdline` path is unchanged.

**Cosmetic existing-directive changes — added install-assets.** Upstream 0.3.2 also packages reference copies of three ledger templates as directive `install-assets/`:

- `agent-steering-accounting/install-assets/STEERING.md`
- `agent-token-accounting/install-assets/COSTS.md`
- `issues-tracked/install-assets/QUALITY.md`
- `issue-templates/install-assets/.github/ISSUE_TEMPLATE/{bug,proposal,config}.yml`

Augment-mode seeding skipped every one of these — the repo already has live tracked versions (init seeded them, and `STEERING.md` / `COSTS.md` have months of real ledger rows now). Skipping was the desired outcome: install-assets are seeds, not authoritative content, so trampling user-tracked ledgers would be a bug.

**Hook dispatchers intentionally not regenerated.** The 0.3.1 → 0.3.2 update adds one directive (`workflows-hardened`, `hook: pre-commit`) and modifies two existing directives' helper scripts — no new hook kind, no new `hooks/<kind>.sh` populator under a hook the dispatcher didn't already discover. The existing `.githooks/pre-commit` walks `.governance/packs/*/*/directives/*` at commit time via `directive_dirs_for_hook`, so the new directive is picked up automatically without regeneration. Skipping regen also preserves the hand-added lint guard block from #19 at the top of `.githooks/pre-commit`, which `governance kit update` (not `pack update`) would have re-injected per its own playbook.

## Verification

- `head -10 .governance/packs.lock` → first pack entry shows `version: 0.3.2`, `sha: ff76a2827e8653f4998817d7b654f4735c2cdfa5`, `ref: gh:Duaility/governance-kit/packs/core@main`.
- `ls .governance/packs/governance-kit/core/directives/` → 14 directives including `workflows-hardened`. No `evals/`, no `install-assets/` (excluded by `copy_tree_without_evals`).
- `bash .governance/run.sh workflows-hardened` → `✓ workflows-hardened`.
- `bash .governance/run.sh` → `✓ governance: all 20 directive(s) passed` (14 core + 6 centraid-local).
- `grep -c 'argv.py' .governance/packs/governance-kit/core/directives/agent-{steering,token}-accounting/hooks/pre-commit.sh` → both 1.
- `head -2 .githooks/pre-commit` still shows `generated=2026-05-26` (untouched); the lint guard block between `GOVERNANCE_DIR=` and `directive_field()` is intact.

## Out of scope

- No `governance kit update` run. The kit-runtime files (`run.sh`, `lib.sh`, `enable-governance.sh`, hook dispatchers) were last regenerated at `kit-version=0.3` and remain stamped that way; bumping them is a separate verb against a separate version axis.
- No changes to the repo-local `srikanth235/centraid` pack — only `governance-kit/core` was re-pinned.
- Upstream issue Duaility/governance-kit#140 (`lib/argv.py` macOS fix) is fully consumed via this re-pin; no local follow-up needed.
