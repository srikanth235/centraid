# issue-233 — Pin governance-kit/core to immutable tag core/v0.4.0

GitHub issue: [#233](https://github.com/srikanth235/centraid/issues/233)

Follow-up to #232, which re-pinned `governance-kit/core` to the floating `@main`
SHA. This holds a deliberate version by pinning the immutable release tag
`core/v0.4.0` instead, so `pack update` no longer chases `main`'s tip.

## Checklist

- [x] Repin packs.lock core entry from @main to the core/v0.4.0 tag
- [x] Confirm the tag content is identical to the installed files
- [x] Keep the governance suite green

## What changed

Repin packs.lock core entry from @main to the core/v0.4.0 tag: the
`.governance/packs.lock` `governance-kit/core` entry now records
`ref: gh:Duaility/governance-kit/packs/core@core/v0.4.0` and
`sha: e9d339c…` (the annotated tag's commit), replacing the floating `@main`
ref / `138eaf5` SHA. Version, directive list, subpath, and `min_governance_kit`
are unchanged.

No directive files moved — the `packs/core` tree at the tag is byte-identical
to the `138eaf5` content installed in #232.

## Out of scope

- Re-pinning the repo-local `srikanth235/centraid` pack — it has no upstream
  ref.
- Any directive content or kit-runtime change — this is a lockfile-only repin.

## Decisions

- **Pinned the annotated tag's underlying commit `e9d339c`, not the main tip
  `138eaf5`.** The tag was cut before a later no-op `main` commit (deleting an
  orphaned file outside `packs/core`). Confirm the tag content is identical to
  the installed files held: `diff -rq` of the two cache trees reported no
  differences, so pinning the tag SHA keeps the exact rules already running —
  the repin is provenance-only, with zero risk of silently swapping rule content.

## Verification

- Repin packs.lock core entry from @main to the core/v0.4.0 tag: `grep -E 'ref:|sha:'`
  on the core entry shows the `@core/v0.4.0` ref and `e9d339c…` SHA.
- Confirm the tag content is identical to the installed files: `diff -rq` of the
  tag cache vs the previously-installed `138eaf5` cache reported identical
  (pure ref/sha repin).
- Keep the governance suite green: `bash .governance/run.sh` exits 0 — all 22
  directives pass.
