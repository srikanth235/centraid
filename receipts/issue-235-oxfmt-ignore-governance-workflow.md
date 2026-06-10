# issue-235 — Stop oxfmt from re-breaking CI on the kit-managed governance workflow

GitHub issue: [#235](https://github.com/srikanth235/centraid/issues/235)

PR #234's kit restamp copied `.github/workflows/governance.yml` from the kit's
0.3.5 source, which has a double space before an inline comment. `oxfmt --check`
(the `ci` job) requires one space, so CI failed. `.oxfmtrc.jsonc` already ignores
`.governance/**` for this exact reason but not this file, which lives outside
`.governance/`.

## Checklist

- [x] Add .github/workflows/governance.yml to the oxfmtrc ignorePatterns and confirm format:check passes
- [x] Keep governance.yml byte-identical to the kit source (no reformat)
- [x] Confirm the governance suite passes

## What changed

Add `.github/workflows/governance.yml` to the `ignorePatterns` in
`.oxfmtrc.jsonc`, with a comment mirroring the existing `.governance/**`
rationale: the workflow is kit-owned (carries the `# governance-kit:managed
kit-version=` marker, re-stamped from `assets/governance.yml` on every `kit
update`), so reformatting it diverges from upstream and re-breaks CI on the next
update.

Keep governance.yml byte-identical to the kit source (no reformat): the
transient `oxfmt` reformat applied while diagnosing was reverted, so the file
still matches what `kit update` wrote.

## Out of scope

- The kit's canonical `governance.yml` not being oxfmt-clean — that is an
  upstream fix (Duaility/governance-kit#170), not a repo change.
- Other kit-seeded `.github/` files (e.g. `ISSUE_TEMPLATE/*.yml`) — they are
  seeded once in augment mode, not re-stamped per update, so they do not have
  the recurring-drift problem and are left as-is.

## Decisions

- **Chose the ignore-pattern fix over reformatting the file.** Reformatting was
  the original plan (and what #53 did after the 0.2 → 0.3 update), but the
  `.oxfmtrc.jsonc` comment explicitly warns that rewriting kit-owned files
  diverges from upstream and re-breaks CI on the next `kit update`. Extending
  the ignore rule fixes the class of failure permanently instead of band-aiding
  this instance; #53 reformatting the same file a year of updates ago is the
  evidence the band-aid does not hold.
- **Scoped the ignore to the exact file**, not a `**/governance.yml` glob, to
  avoid silently excluding any unrelated future file of the same name.

## Verification

- Add .github/workflows/governance.yml to the oxfmtrc ignorePatterns and confirm
  format:check passes: `bun run format:check` reports "All matched files use the
  correct format" (508 files — one fewer than before, the now-ignored workflow).
- Keep governance.yml byte-identical to the kit source: `git diff --stat
  .github/workflows/governance.yml` is empty (matches the committed kit version).
- Confirm the governance suite passes: `bash .governance/run.sh` exits 0 — all
  22 directives pass.
