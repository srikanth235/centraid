# Issue #246 — chore(governance): kit update 0.6.0 → 0.12.0

GitHub issue: [#246](https://github.com/srikanth235/centraid/issues/246)

Re-sync the kit runtime from the pinned 0.6.0 to the latest published 0.12.0.
Forward update, delegated to the target (0.12.0) engine fetched by the
installer shim's resolve — the code that writes version X's files is version
X's code. The move also completes the issue #267 de-vendoring of
`enable-governance.sh` that the upgrade otherwise leaves stranded.

## Checklist

- [x] Updated the managed runtime files to kit-version 0.12.0
- [x] Regenerated the hook dispatchers
- [x] Recorded the new pin in install.yaml
- [x] De-vendored enable-governance.sh per issue #267
- [x] Verified the full smoke test passes

## What changed

**Updated the managed runtime files to kit-version 0.12.0.** The delegated
`kit-apply` rewrote `.governance/run.sh`, `.governance/lib.sh` (a substantive
542-line diff), and `.github/workflows/governance.yml`, each restamped with the
`# governance-kit:managed kit-version=0.12.0` marker.

**Regenerated the hook dispatchers** (`.githooks/{pre-commit,commit-msg,
prepare-commit-msg,post-commit,pre-push}`) via the 0.12.0 generator so directive
`hook:` wiring catches up to the new engine.

**Recorded the new pin in install.yaml** — `kit_version: 0.12.0`,
`kit_ref: gh:duaility/governance-kit/kit@kit/v0.12.0`,
`kit_sha: 60dfb5fb…`, plus the refreshed `managed_digests`. The `kit-apply`
wrote `kit_version`; the separate `kit-pin` step wrote `kit_ref`/`kit_sha`.

**De-vendored enable-governance.sh per issue #267.** v0.12.0 no longer ships
`enable-governance.sh` as a managed asset — enablement moved to git's
`core.hooksPath` (already `.githooks` here). The upgrade engine preserves every
manifest field, so it left the legacy 0.6.0-stamped copy and the
`enable_governance_script` field behind, which the new `kit-version-sync`
directive (derived from the manifest's managed set) flagged. Reconciled to match
a fresh 0.12.0 install: dropped the `enable_governance_script` field from
`install.yaml`, `git rm`'d the inert script, and replaced its now-dangling
`AGENTS.md` link with a note on the `core.hooksPath` enablement.

## Decisions

- **Full de-vendoring over keeping an inert copy.** v0.12.0's own
  `kit-version-sync` derives the managed set from the manifest, so simply
  keeping the stale-stamped file would keep failing the smoke test. Removing the
  manifest field + the file matches exactly what a fresh 0.12.0 install looks
  like; `core.hooksPath` (already set) preserves hook enablement.
- **Manifest field removed by hand.** No update-path engine strips deprecated
  manifest fields on upgrade (`kit-apply` preserves them by design), and there
  is no verb for it — so the #267 migration is completed as a documented manual
  reconciliation, verified by the passing `kit-version-sync` directive.
- **Committed separately from the teal rebrand (#245).** Kit-runtime changes and
  feature work are disjoint concerns.

## Out of scope

- No `--with-packs`: pack content (`packs.lock` SHAs / directive folders) is a
  separate concern and unchanged this run.
- The unrelated `.governance/` deletions and `docs/index.mdx` /
  `blueprints/manifest.json` / docs-site script edits bundled in `stash@{0}`
  remain there, untouched.

## Verification

Verified the full smoke test passes.

```sh
bash .governance/run.sh          # ✓ all 21 directives passed
grep -c kit-version=0.12.0 .governance/run.sh .governance/lib.sh \
  .github/workflows/governance.yml .githooks/*   # every managed file at 0.12.0
grep kit_version .governance/install.yaml        # kit_version: "0.12.0"
git config --get core.hooksPath                  # .githooks (hooks still enabled)
```
