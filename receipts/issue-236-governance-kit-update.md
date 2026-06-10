# issue-236 — Governance kit update 0.3.5 → 0.4.0

GitHub issue: [#236](https://github.com/srikanth235/centraid/issues/236)

Re-sync the kit-runtime files to governance-kit **0.4.0**. The local
`governance` skill was already current (`npx skills update governance --global`
reported up-to-date), so `governance kit update` resolved a clean **forward**
update: 0.3.5 → 0.4.0. Disjoint from any pack content — this is a pure
kit-runtime marker bump with no behavioral changes to the runtime scripts this
release.

## Checklist

- [x] Refresh the local governance skill before the update (already up-to-date)
- [x] Restamp the four managed runtime files to kit-version 0.4.0
- [x] Bump install.yaml kit_version to 0.4.0
- [x] Regenerate the hook dispatchers at kit-version 0.4.0
- [x] Run the governance suite green

## What changed

One axis moved: kit runtime 0.3.5 → 0.4.0 (no pack update this turn).

`governance kit update` restamped the four managed runtime files — the body
diff was `# governance-kit:managed kit-version=` marker-only (0.3.5 → 0.4.0),
no behavioral change:

- `.governance/run.sh`
- `.governance/lib.sh`
- `.github/workflows/governance.yml`
- `scripts/enable-governance.sh`

Plus `install.yaml.kit_version` stamped to 0.4.0 and the hook dispatchers
(`.githooks/*`) regenerated at kit-version 0.4.0 so every marker agrees with
the manifest.

## Out of scope

- `--with-packs` — pack content (`governance-kit/core`, the repo-local
  `srikanth235/centraid` pack) was not touched. Pack updates land under their
  own diff-before-exec review per the kit/pack version split.
- Fixing the 0.4.0 `governance.yml` double-space-before-inline-comment upstream
  — already neutralized locally by the `.oxfmtrc.jsonc` exclusion (#235).

## Decisions

- **Kit-runtime only, no `--with-packs`.** The user asked to update the kit
  version; pack content is a separate concern with separate diffs. Kept this a
  pure local file-copy + manifest rewrite (no network).
- **Created tracking issue #236 rather than anchoring to #235.** #235 is the
  oxfmt-ignore fix (already landed), not this version bump. A routine kit-runtime
  sync gets its own anchor so the receipt-per-issue trail stays one-issue-deep.

## Verification

- Refresh the local governance skill before the update (already up-to-date):
  `npx skills update governance --global` reported all global skills
  up-to-date; `kit-plan` resolved `kit_version: 0.4.0` vs
  `installed_kit_version: 0.3.5`, `delta: forward`.
- Restamp the four managed runtime files to kit-version 0.4.0: `kit-apply`
  reported `result: applied`, all four files in `updated`; every managed
  file's `kit-version=` marker reads `0.4.0`.
- Bump install.yaml kit_version to 0.4.0: `kit-apply` reported
  `manifest: updated`; `grep kit_version .governance/install.yaml` shows
  `0.4.0`.
- Regenerate the hook dispatchers at kit-version 0.4.0: `kit-apply` reported
  `hook_dispatcher: regenerated`.
- Run the governance suite green: `kit-apply` smoke test —
  `✓ governance: all 22 directive(s) passed` (exit 0).
