# issue-232 — Governance kit update 0.3 → 0.3.5 (+core pack 0.4.0)

GitHub issue: [#232](https://github.com/srikanth235/centraid/issues/232)

`governance kit update` reported "up-to-date" even though governance-kit 0.3.5
was published. Root cause was not the repo: the locally installed `governance`
skill was stale (last synced 2026-05-08, hard-coded `KIT_VERSION = "0.3"`,
missing `assets/kit.yaml`), so the verb resolved the "available" version from
old code. Re-syncing the skill, then running the update across both the kit and
pack axes, brought the repo current.

## Checklist

- [x] Re-sync the stale local governance skill to 0.3.5
- [x] Restamp the four managed runtime files to kit-version 0.3.5
- [x] Bump install.yaml kit_version to 0.3.5
- [x] Update core pack 0.3.2 to 0.4.0 and re-pin the lockfile SHA
- [x] Install the new doc-integrity and version-consistency directives
- [x] Seed .governance/integrity.conf
- [x] Update receipt-per-issue to the Decisions-section snippet
- [x] Splice the new directive subsections and Evolution Log entry into CONSTITUTION.md
- [x] Regenerate the hook dispatchers at kit-version 0.3.5
- [x] Run the governance suite green

## What changed

Two independent axes moved, per the kit's kit-vs-pack version model.

**Kit runtime 0.3 → 0.3.5.** Re-sync the stale local governance skill to 0.3.5
via `npx skills update governance --global` (it now reads `assets/kit.yaml` →
`0.3.5`). Restamp the four managed runtime files to kit-version 0.3.5 —
`.governance/run.sh`, `.governance/lib.sh`, `scripts/enable-governance.sh`,
`.github/workflows/governance.yml` (body diff was version-stamp-only plus one
cosmetic CI whitespace fix). Bump install.yaml kit_version to 0.3.5 and record
`.governance/integrity.conf` in `install_assets_seeded`.

**Core pack 0.3.2 → 0.4.0.** Re-pin the lockfile SHA from `ff76a28` to
`138eaf5` (`.governance/packs.lock`, ref kept at `@main`). Install the new
doc-integrity and version-consistency directives plus the refreshed
`commit-message-format` / `receipt-per-issue` check scripts under
`.governance/packs/governance-kit/core/directives/`. Seed
`.governance/integrity.conf` with the default rule set (the always-install
`doc-integrity` directive's config). Update receipt-per-issue to the
Decisions-section snippet in `CONSTITUTION.md` and splice the new directive
subsections and Evolution Log entry into CONSTITUTION.md. Regenerate the hook
dispatchers at kit-version 0.3.5 so the new `doc-integrity` (commit-msg) and
`version-consistency` (pre-commit) directives are wired and every `.githooks/*`
marker agrees with the manifest.

## Out of scope

- Pinning the core pack to the immutable `core/v0.4.0` tag — the existing pin
  tracks `@main` and was left as-is to keep this update a pure SHA re-pin. Can
  be tightened later via `governance pack add` with a tagged ref.
- Opting any additional documents into `.governance/integrity.conf` beyond the
  shipped defaults.
- Updating the repo-local `srikanth235/centraid` pack (unchanged; it has no
  upstream).

## Decisions

- **Kept the core pack ref on `@main` rather than switching to the `core/v0.4.0`
  tag.** The lock already floated on `@main`; re-pinning the SHA in place is the
  minimal, behavior-preserving move. Pinning a tag is a deliberate separate
  decision (noted in Out of scope), not something to fold into a routine update.
- **`integrity.conf` seeded with all default rules enabled.** That is the kit's
  shipped default for the always-install `doc-integrity` directive; every rule
  is a no-op until its named document exists, so the default is safe for this
  repo (`COSTS.md`, `STEERING.md`, `QUALITY.md`, `receipts/*.md`, and the
  CONSTITUTION Evolution Log are all already present, and the prior commit
  history is the baseline, so nothing historical is retroactively frozen).
- **Manual restamp of the runtime files via the kit's `stamp_managed_marker`
  helper** because macOS ships bash 3.2 (no associative arrays); the helper
  functions themselves are the kit's own, so the output is identical to what the
  flow's reference snippet would produce.

## Verification

- Re-sync the stale local governance skill to 0.3.5: `packctl.py kit-version`
  now prints `0.3.5` (was `0.3`).
- Restamp the four managed runtime files to kit-version 0.3.5 and regenerate the
  hook dispatchers at kit-version 0.3.5: every managed file's `kit-version=`
  marker reads `0.3.5`, matching `install.yaml`; the new `version-consistency`
  directive passes.
- Bump install.yaml kit_version to 0.3.5: `grep kit_version .governance/install.yaml`
  shows `0.3.5`.
- Update core pack 0.3.2 to 0.4.0 and re-pin the lockfile SHA: `packs.lock`
  governance-kit/core entry shows `version: 0.4.0`, `sha: 138eaf5…`.
- Install the new doc-integrity and version-consistency directives and seed
  .governance/integrity.conf: both directive folders exist under
  `.governance/packs/governance-kit/core/directives/` and `.governance/integrity.conf`
  is present.
- Update receipt-per-issue to the Decisions-section snippet and splice the new
  directive subsections and Evolution Log entry into CONSTITUTION.md: the
  rendered `### receipt-per-issue`, `### doc-integrity`, `### version-consistency`
  subsections and the dated Evolution Log line are present.
- Run the governance suite green: `bash .governance/run.sh` exits 0 with all
  directives passing.
