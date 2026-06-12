# issue-240 — Governance kit update 0.5.0 → 0.6.0

GitHub issue: [#240](https://github.com/srikanth235/centraid/issues/240)

`governance kit update` moved the repo from the pinned **0.5.0** kit runtime to
the latest published **0.6.0**. v0.6.0 relocated the kit artifact from the
`governance/` subdirectory to a top-level `kit/` directory
([Duaility/governance-kit#198](https://github.com/Duaility/governance-kit/issues/198)),
so the repo's recorded pin — which hardcoded the old `governance/` subpath —
could not be followed by the 0.5.0 engine, which silently fell back to the
cached pin and falsely reported `kit: up-to-date`. The update was orchestrated
from the 0.6.0 engine fetched via the installer shim's `resolve` (which knows
the new `kit/` subpath). Pure kit-runtime axis — no pack content moved.

## Checklist

- [x] Refresh the local governance skill
- [x] Resolve the 0.6.0 target via the installer shim and fetch its engine
- [x] Apply the four managed runtime files at kit-version 0.6.0
- [x] Bump install.yaml kit_version and record the new kit/ subpath pin
- [x] Regenerate the hook dispatchers at kit-version 0.6.0
- [x] Run the governance suite green

## What changed

A single axis moved: the kit runtime, 0.5.0 → 0.6.0. Unlike the 0.5.0 bump,
this is a substantive runtime upgrade — `.governance/lib.sh` is largely
rewritten (≈203 non-marker lines) and `.governance/run.sh` changed (≈19 lines);
`scripts/enable-governance.sh` is marker-only and
`.github/workflows/governance.yml` changed two lines.

Apply the four managed runtime files at kit-version 0.6.0 —
`.governance/run.sh`, `.governance/lib.sh`, `scripts/enable-governance.sh`,
`.github/workflows/governance.yml` — each re-stamped to
`# governance-kit:managed kit-version=0.6.0`.

Bump install.yaml kit_version to 0.6.0 and record the new kit/ subpath pin:
`kit_ref` is now `gh:duaility/governance-kit/kit@kit/v0.6.0` (note the `kit/`
subpath, replacing the retired `governance/` one) and `kit_sha` is `adf9590`.
Regenerate the hook dispatchers at kit-version 0.6.0 so every `.githooks/*`
dispatcher marker agrees with the manifest. No core or repo-local pack content
changed; `packs.lock` and `CONSTITUTION.md` are untouched.

## Out of scope

- The `core` pack decomposition. v0.6.0 splits the monolithic `core` pack into
  concern-scoped packs and retires the `core/vX.Y.Z` axis
  ([Duaility/governance-kit#193](https://github.com/Duaility/governance-kit/issues/193)).
  This repo's `core` pack stays pinned at the immutable `core/v0.4.0` tag;
  migrating to the new concern packs is a deliberate `pack remove`/`pack add`
  operation tracked separately, not part of this kit-runtime-only run (no
  `--with-packs`).
- The repo-local `srikanth235/centraid` pack — untouched.
- The unrelated untracked working-tree files (`scripts/home-site/`,
  `wrangler.home.toml`) — left unstaged; not part of this update.

## Decisions

- **Orchestrated from the 0.6.0 engine fetched via the installer shim, not the
  pinned 0.5.0 engine.** The 0.5.0 engine's resolver predates the `governance/`
  → `kit/` rename and cannot fetch the 0.6.0 tree, so it reported a false
  no-op. The shim's `resolve` already targets the new `kit/` subpath, so
  fetching 0.6.0 and delegating apply to its own `kit-apply` is the only correct
  path across the layout rename — the code that writes 0.6.0's files is 0.6.0's
  code.
- **Kit-runtime only; deferred the core-pack decomposition.** `kit update` and
  pack-content migration are disjoint concerns. The core axis retirement is a
  larger, breaking migration deserving its own review, and `core` is pinned to
  an exact immutable tag, so it is unaffected by this run.
- **Applied over a dirty working tree with `--force`.** The only dirty entries
  are unrelated untracked files (`scripts/home-site/`, `wrangler.home.toml`);
  the apply and the staged set touch nothing but the governance surface, so the
  override is safe.

## Verification

```sh
# Resolve + fetch the 0.6.0 engine via the installer shim, confirm the move.
python3 ~/.claude/skills/governance/bootstrap.py resolve --to 0.6.0
# Apply + pin, then run the suite (kit-apply's smoke test).
bash .governance/run.sh
grep -E 'kit_version|kit_ref|kit_sha' .governance/install.yaml
```

- Refresh the local governance skill: `npx skills update governance --global
  --yes` reported all global skills already up to date; the installed shim is
  byte-identical to upstream v0.6.0's `skill/`.
- Resolve the 0.6.0 target via the installer shim and fetch its engine:
  `bootstrap.py resolve --to 0.6.0` returned `kit_ref:
  gh:duaility/governance-kit/kit@kit/v0.6.0`, and the 0.6.0 engine's
  `kit-resolve` reported `target_version: 0.6.0`, `provenance: published-tag`,
  `direction: forward`, `delegate: true`.
- Apply the four managed runtime files at kit-version 0.6.0: `kit-apply`
  returned `result: applied` with `updated` listing all four files; every
  managed-file `kit-version=` marker reads 0.6.0, matching `install.yaml`, so
  the `version-consistency` directive passes.
- Bump install.yaml kit_version and record the new kit/ subpath pin:
  `kit_version: "0.6.0"`, `kit_ref: gh:duaility/governance-kit/kit@kit/v0.6.0`,
  and `kit_sha: adf959096…` are present in `.governance/install.yaml`.
- Regenerate the hook dispatchers at kit-version 0.6.0: `kit-apply` returned
  `hook_dispatcher: regenerated` and every `.githooks/*` dispatcher
  `kit-version=` marker reads 0.6.0.
- Run the governance suite green: `kit-apply`'s smoke test ran
  `bash .governance/run.sh` to exit 0 — "✓ governance: all 22 directive(s)
  passed".
