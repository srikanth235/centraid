# install-upgrade-lifecycle (W5.4, #842)

**Claim.** Installing a **previous release**, writing real data through it, then upgrading **in place** over that data never eats the vault — every pre-existing record survives the swap, and the upgraded install still runs a journey.

**Why it is not covered elsewhere.** No lane installs a prior release and upgrades over live data. Fresh-install boot smoke (`scripts/release/boot-smoke`) proves the artifact starts; it never proves an upgrade preserves what was there.

**Shape.** The rig (`CENTRAID_UPGRADE_RIG`) installs the previous release, seeds rows (returning a digest map), upgrades in place, re-snapshots the same rows, and runs a post-upgrade journey. `assertUpgradePreservedData(before, after)` in `../lib/upgrade.mjs` is the load-bearing check — a dropped or mutated pre-existing row fails; a newly-migrated row is allowed. Verdict via `judgeUpgradeJourney`. Both are unit-pinned in `../lib/upgrade.test.mjs`.

**Current state — blocked-external (#790).** The launchd install/uninstall rig is a **named #790 blocker** ("No named mutable macOS user-session rig; local opt-in only" — TESTING.md §Named live/hardware lanes). With no installer the lane **skips with citation**. The upgrade-over-data assertion logic is already landed and green — only the installer half is blocked.

**Unblock condition.** **#790** provisioning a mutable user-session install / uninstall runner. Then set `CENTRAID_UPGRADE_PREV_INSTALLER` to the prior release's artifact in the (macOS) nightly job.
