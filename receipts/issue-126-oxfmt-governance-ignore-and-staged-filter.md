# issue-126 — oxfmt: ignore .governance/ + broaden lint-staged filter

GitHub issue: [#126](https://github.com/srikanth235/centraid/issues/126)

## Checklist

- [x] `.governance/**` added to oxfmt `ignorePatterns`
- [x] `scripts/lint-staged.sh` regex extended with `jsonc|mdx|yaml|yml`
- [x] Local `bun run format:check` clears the three governance-pack failures
- [x] Local dry-run confirms the new regex matches `.jsonc` / `.mdx` files

## What changed

**`.governance/**` added to oxfmt `ignorePatterns`.** `.oxfmtrc.jsonc` previously listed only `dist`, `.expo`, `node_modules`, `*.md`, and a single `xcassets/Contents.json` carve-out. Added `.governance/**` so oxfmt skips the entire governance-kit-managed tree — `directive.yaml`, `check.sh`, `run.sh`, `install.yaml`, `packs.lock`, hook dispatchers, etc. The trigger was the [#125](https://github.com/srikanth235/centraid/issues/125) pack update: upstream 0.3.1 normalized `summary:` fields in three `directive.yaml` files from single to double quotes, and the local `singleQuote: true` rule rejected them in CI. Reformatting the upstream content locally would just guarantee the next `pack update` / `kit update` re-introduces the diff and re-breaks CI — the right place to draw the line is "governance-kit owns its tree, don't touch it."

**`scripts/lint-staged.sh` regex extended with `jsonc|mdx|yaml|yml`.** The pre-commit lint guard filtered staged files through `grep -E '\.(ts|tsx|js|jsx|mjs|cjs|json|md)$'` before passing them to oxfmt. Four formats oxfmt understands were missing: `.jsonc` (the project uses it for `.oxfmtrc.jsonc`), `.mdx` (every `docs/**` file), `.yaml`, and `.yml` (governance pack content + GitHub Actions). The blind spot is what let the pack-update commit slip through with zero files matched — the hook reported "0 files" success while CI's `oxfmt --check .` swept the repo and found the misformatted YAML. With the regex broadened, the same change would have failed at `git commit` and never reached CI.

## Verification

- **Local `bun run format:check` clears the three governance-pack failures.** Running it after the change shows only the three pre-existing `docs/*.mdx` failures (introduced by commit `dad00ad`, out of scope); the three `.governance/packs/**/*.yaml` failures that broke CI on `c9fe4f0` are gone.
- **Local dry-run confirms the new regex matches `.jsonc` / `.mdx` files.** `git diff --name-only --diff-filter=ACMR | grep -E '\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|mdx|yaml|yml)$'` against the working tree returns `.oxfmtrc.jsonc` and `docs/concepts/*.mdx` — both formats that the old regex silently dropped.

## Out of scope

- **Three pre-existing `docs/*.mdx` failures on `main`** (`docs/deploy/sqlite-layout.mdx`, `docs/getting-started.mdx`, `docs/index.mdx`). They predate this issue (commit `dad00ad`) and would have been caught by the new staged-filter regex had it been in place at the time. Tracked separately — auto-fixable via `bun run format` (the diff is pure markdown italics style, `*x*` → `_x_`).
- **`scripts/lint-staged.sh` regex extension to other oxfmt-aware formats** (CSS, HTML if added later). Stuck to the formats currently present in this repo; expand on demand.
