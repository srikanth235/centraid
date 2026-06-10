# issue-236 — Governance kit update 0.3.5 → 0.5.0

GitHub issue: [#236](https://github.com/srikanth235/centraid/issues/236)

`governance kit update` resolved the latest published `kit/vX.Y.Z` tag to
**0.5.0** and re-synced the four managed runtime files plus the hook
dispatchers from the repo's pinned 0.3.5. The issue was filed anticipating
0.4.0, but the latest published kit had since moved to 0.5.0, so this run goes
one version further. Pure kit-runtime axis — no pack content moved.

## Checklist

- [x] Refresh the local governance skill
- [x] Resolve the target via the published tag and fetch its engine
- [x] Restamp the four managed runtime files to kit-version 0.5.0
- [x] Bump install.yaml kit_version and record the kit_ref/kit_sha pin
- [x] Regenerate the hook dispatchers at kit-version 0.5.0
- [x] Run the governance suite green

## What changed

A single axis moved: the kit runtime, 0.3.5 → 0.5.0.

Restamp the four managed runtime files to kit-version 0.5.0 —
`.governance/run.sh`, `.governance/lib.sh`, `scripts/enable-governance.sh`,
`.github/workflows/governance.yml`. The body diff was **version-marker-only**:
every file's logic is byte-identical between 0.3.5 and 0.5.0; only the
`# governance-kit:managed kit-version=` line changed.

Bump install.yaml kit_version to 0.5.0 and record the repo-pinned model's
`kit_ref` (`gh:duaility/governance-kit/governance@kit/v0.5.0`) and `kit_sha`
(`472203d`). Regenerate the `.githooks/*` dispatchers at kit-version 0.5.0 so
every dispatcher marker agrees with the manifest. No core or repo-local pack
content changed; `packs.lock` and `CONSTITUTION.md` are untouched.

## Out of scope

- Updating the core pack or the repo-local `srikanth235/centraid` pack — this
  is a kit-runtime-only run (no `--with-packs`). The core pack stays pinned at
  the immutable `core/v0.4.0` tag.
- The unrelated untracked working-tree files (`scripts/home-site/`,
  `wrangler.home.toml`) — left unstaged; not part of this update.

## Decisions

- **Went to 0.5.0 rather than the 0.4.0 named in the issue title.** The latest
  published `kit/vX.Y.Z` tag is the resolution default, and it had advanced to
  0.5.0 since the issue was filed. Stopping at 0.4.0 would leave the repo a
  version behind immediately; the diff is marker-only either way, so taking the
  current published kit is the lower-friction, equivalent-risk choice.
- **Delegated apply to the fetched 0.5.0 engine.** Forward updates run the
  target tree's own `kitverb.py kit-apply`, so version 0.5.0's files are written
  by version 0.5.0's code and the markers cannot lie.
- **Applied over a dirty working tree with `--force`.** The only dirty entries
  are unrelated untracked files; the apply and the staged set touch nothing but
  the governance surface, so the override is safe.

## Verification

- Refresh the local governance skill: `npx skills update governance --global
  --yes` reported all global skills already up to date.
- Resolve the target via the published tag and fetch its engine: `kit-resolve`
  reported `target_version: 0.5.0`, `provenance: published-tag`,
  `direction: forward`, `delegate: true`.
- Restamp the four managed runtime files to kit-version 0.5.0: `kit-apply`
  returned `result: applied` with `updated` listing all four files; every
  managed-file `kit-version=` marker reads 0.5.0, matching `install.yaml`, so
  the `version-consistency` directive passes.
- Bump install.yaml kit_version and record the kit_ref/kit_sha pin:
  `kit_version: "0.5.0"` and the `kit_ref`/`kit_sha` fields are present in
  `.governance/install.yaml`.
- Regenerate the hook dispatchers at kit-version 0.5.0: `kit-apply` returned
  `hook_dispatcher: regenerated` and every `.githooks/*` dispatcher
  `kit-version=` marker reads 0.5.0.
- Run the governance suite green: `kit-apply`'s smoke test ran
  `bash .governance/run.sh` to exit 0 — "✓ governance: all 22 directive(s)
  passed".
