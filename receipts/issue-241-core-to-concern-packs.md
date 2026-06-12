# issue-241 — Migrate off retired core pack to 0.6.0 concern packs

GitHub issue: [#241](https://github.com/srikanth235/centraid/issues/241)

Follow-up to [#240](https://github.com/srikanth235/centraid/issues/240) (kit
0.5.0 → 0.6.0). v0.6.0 decomposed the monolithic `governance-kit/core` pack into
five concern-scoped packs and retired the `core/vX.Y.Z` axis
([Duaility/governance-kit#193](https://github.com/Duaility/governance-kit/issues/193)).
This moves centraid off `core/v0.4.0` onto foundation / security / docs /
commits / audit, preserving equivalent enforcement (suite stays green at 21
directives).

## Checklist

- [x] Retire the core pack: remove its directory and lockfile entry
- [x] Add the five concern packs at their latest tags
- [x] Hold back the net-new and changed-model directives for deliberate adoption
- [x] Preserve the append-only ledger model via the doc-integrity overlay
- [x] Fix the stale core link in AGENTS.md
- [x] Rebuild the CONSTITUTION.md Directives section grouped by pack
- [x] Run the governance suite green

## What changed

Retire the core pack: remove its directory and lockfile entry. The monolithic
`.governance/packs/governance-kit/core/` (16 directives) was deleted with `rm`
and its `packs.lock` entry pruned via `packverb lock-remove` — there is no
sanctioned verb to retire core (`pack remove governance-kit/core` is hard-refused
by the `is_core` bedrock guard, and `directive remove` defers `gh`-pack
directives back to `pack remove`).

Add the five concern packs at their latest tags via `pack-apply add`:
`foundation@foundation/v0.2.1`, `security@security/v0.2.0`, `docs@docs/v0.2.1`,
`commits@commits/v0.2.1`, `audit@audit/v0.3.0`. This maps the 14 retained core
directives — including the renames `version-consistency` → `kit-version-sync`
and `no-broken-internal-doc-links` → `internal-doc-links`, and the
`workflows-hardened` → `pinned-dependencies` + `token-permissions` split — onto
their new homes. Conf overlays were seeded at `.governance/conf/governance-kit/<pack>/<id>.conf`.

Hold back the net-new and changed-model directives for deliberate adoption:
`audit` and `commits` were installed via `--decisions skip` so that
`toolchain-config-protection`, `no-unjustified-suppressions`,
`agent-token-accounting`, and `agent-steering-accounting` are not installed.
The first two are net-new (they would require app-code changes and per-commit
waivers); the accounting pair changed from a `COSTS.md` ledger to a
receipts-based model (issue #201) and adopting them requires migrating the
ledger model and rewriting the #240 kit-update commit.

Preserve the append-only ledger model via the doc-integrity overlay: the new
audit-pack default seals `COSTS.md` / `STEERING.md` (`frozen-files`), but
`.governance/conf/governance-kit/audit/doc-integrity.conf` drops those defaults
and re-asserts `append-only COSTS.md` / `append-only STEERING.md` — exactly the
rules the now-removed `.governance/integrity.conf` carried. The dead flat
`.governance/integrity.conf` and `.governance/freshness.conf` (read only by the
old core directives) were removed.

Fix the stale core link in AGENTS.md: the `commit-message-format` enforced-by
link now points at `.governance/packs/governance-kit/commits/directives/commit-message-format/check.sh`.

Rebuild the CONSTITUTION.md Directives section grouped by pack: the `## Directives`
body was reassembled from each installed directive's shipped `constitution.md`
snippet, grouped under `<!-- pack: … -->` markers (foundation, security, docs,
commits, audit, then the local `srikanth235/centraid` directives), replacing the
stale core-era sections (several of which `pack-apply remove`'s docsurgery had
already stripped). An Evolution Log entry records the migration (append-only;
existing entries untouched).

## Out of scope

- **Adopting the held-back 0.6.0 directives.** `toolchain-config-protection`,
  `no-unjustified-suppressions`, `agent-token-accounting`, and
  `agent-steering-accounting` are a separate, deliberate adoption: it requires
  justifying 13 pre-existing `eslint-disable`s in app code, adding
  per-commit toolchain waivers, and migrating accounting from `COSTS.md` to the
  receipts model (issue #201). Tracked for a follow-up.
- The repo-local `srikanth235/centraid` pack — unchanged.
- The unrelated untracked working-tree files (`scripts/home-site/`,
  `wrangler.home.toml`) — left unstaged; not part of this migration.

## Decisions

- **Removed core by hand because no verb can.** `pack remove governance-kit/core`
  is refused by a hardcoded `is_core` bedrock guard (no override, even
  `--force`), and `directive remove` defers `gh`-pack directives back to
  `pack remove` — a closed loop. The concern packs declare no `replaces:`, so
  adding them alongside core would double-run every overlap. So core was removed
  with `rm` + the sanctioned `lock-remove` helper, then the concern packs added.
- **Enforcement-equivalent scope, not full adoption.** The audit pack v0.3.0
  ships a new accounting/integrity model and two net-new directives whose
  adoption would touch app code and rewrite the #240 commit. Holding them back
  keeps this a clean structural pack swap that stays green, and surfaces the
  model adoption as its own reviewable change.
- **Kept `COSTS.md`/`STEERING.md` append-only via overlay rather than adopting
  the seal.** Sealing them only makes sense once accounting moves to receipts;
  since that model is held back, the overlay preserves centraid's existing
  append-only ledgers — enforcement-equivalent to the removed `integrity.conf`.

## Verification

```sh
# The migrated suite is green at 21 directives (15 concern + 6 local).
bash .governance/run.sh
# Lockfile now lists the five concern packs + the local pack, no core.
uv run --quiet --isolated --with PyYAML python \
  "$(python3 ~/.claude/skills/governance/bootstrap.py current "$PWD" | python3 -c 'import sys,json;print(json.load(sys.stdin)["lib_dir"])')/packverb.py" \
  lock-list .governance/packs.lock
```

- Retire the core pack: remove its directory and lockfile entry —
  `.governance/packs/governance-kit/core/` is gone and `lock-list` shows no
  `governance-kit/core` entry.
- Add the five concern packs at their latest tags — `lock-list` shows
  `governance-kit/{foundation,security,docs,commits,audit}` alongside
  `srikanth235/centraid`; 15 concern directive folders are installed.
- Hold back the net-new and changed-model directives for deliberate adoption —
  `toolchain-config-protection`, `no-unjustified-suppressions`,
  `agent-token-accounting`, `agent-steering-accounting` are absent from
  `.governance/packs/` and from the audit/commits lock `directives:` lists.
- Preserve the append-only ledger model via the doc-integrity overlay —
  `.governance/conf/governance-kit/audit/doc-integrity.conf` carries
  `!frozen-files` + `append-only` for `COSTS.md`/`STEERING.md`; `doc-integrity`
  passes.
- Fix the stale core link in AGENTS.md — `internal-doc-links` passes (no broken
  link to the removed core path).
- Rebuild the CONSTITUTION.md Directives section grouped by pack — 21 `### `
  directive sections under `<!-- pack: … -->` group markers; `required-docs`
  and `internal-doc-links` pass over the rebuilt file.
- Run the governance suite green: `bash .governance/run.sh` exits 0 —
  "✓ governance: all 21 directive(s) passed".
