# Recovery: mid-flight release

When a release prepare/publish attempt strands halfway. Policy: [release.md](../release.md).

## Symptoms

- Version bumped in some packages but not others
- Tag pushed but GitHub Release missing / wrong body
- Changelog section created but tag never cut
- CI release workflow failed after tag
- Maintainer said stop after prepare

## Safe defaults

1. **Prefer abort-and-retry prepare** over hand-editing a half-published state.
2. **Never** force-push a moved `v*` tag that may already be building in the wild without maintainer decision.
3. Agents do **not** publish without a fresh "go ahead."

## Scenarios

### A — Version bump commit exists, no tag

1. Inspect `git status` / `git log -1` and package versions for consistency.
2. If changelog + versions are correct and CI green: maintainer tags and publishes.
3. If incorrect: new commit fixing versions/changelog (still no feature code), then re-approve.

### B — Tag pushed, workflow failed

1. Open the failed Actions run; fix root cause on a follow-up commit if needed.
2. Re-run the failed jobs **or** delete the GitHub Release draft only (not the tag) if the workflow allows rebuild from the same tag.
3. If the tag points at a bad commit: maintainer-only decision to retag (document in issue); agents do not silently retag.

### C — GitHub Release body wrong

1. Edit Release body from the `CHANGELOG.md` section for that version (D3 source of truth).
2. Do not invent release notes in the GitHub UI that disagree with the changelog.

### D — Beta vs stable confusion

1. Confirm tag shape: `vX.Y.Z-beta.N` is pre-release only (D5).
2. Ensure stable download / `latest` was not moved; revert channel config if a workflow did.

### E — Stop after prepare (no publish)

1. Leave the prepare PR open or merge version bump only if maintainer wants versions on main without artifacts.
2. Do not run publish skills.

### F — Wrong surface shipped / mobile accidentally skipped

1. Product version stamps are still correct if `sync-versions` ran — do **not** invent a surface-local version.
2. Dispatch the missing surface (`gh workflow run release-mobile.yml …` or re-run the tag workflow).
3. Update `artifacts/release-ship.json` / release notes only if maintainers care about the audit trail.

### G — Tempted to bump version because CI failed

1. **Stop.** R5: never bump product version only to fix a build.
2. Fix code or workflow; rebuild same tag or surface retry path.
3. Only cut a new patch when there is a real product fix to ship.

## Checklist before retry

- [ ] Single shared product version everywhere (no surface forks)
- [ ] Protocol constants consistent if handshake changed
- [ ] Changelog matches intent (patch vs minor per D4)
- [ ] No extra feature commits on the release tag
- [ ] Ship set still correct (`bun run release:matrix`)
- [ ] Maintainer re-approved if anything changed

## Related

- [release.md](../release.md)
- [enrollment.md](../enrollment.md)
