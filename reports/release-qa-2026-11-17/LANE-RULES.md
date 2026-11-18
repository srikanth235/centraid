# Release QA lane rules (2026-11-17)

Two lanes, iOS and Android, each one Sonnet agent directed by the orchestrator. These rules bind both.

## What is under test

- Release candidate: main `99cc70d8f`. The checkout `/Users/srikanth/gitspace/centraid` is detached there. Do not switch branches, commit, push, or edit source, mockups or tests. This is QA: report defects, do not fix them.
- Plan: `reports/release-test-plan-2026-11-17/PLAN.md`. Expectations come from `.claude/skills/product/` (SKILL.md, promises.md, rulings/), `.claude/skills/design/` (behaviour.md, wording.md) and the boards in `design/mockups/`. How to build and run: `.claude/skills/land/mobile-commands.md` and `mobile-pitfalls.md`. How to report: `.claude/skills/land/report.md`.
- Earlier evidence, for case lists and known issues only (it is not evidence for this build): `reports/ios-promises-2026-11-12/COVERAGE.md`, `PR-VALIDATION-OPEN-ISSUES.md`, `reports/android-promises-2026-11-12/REPORT.md`, `reports/mobile-audit-2026-11-13/README.md`.

## Cargo belongs to the orchestrator

- Do not run `cargo build`, `cargo test`, `cargo xtask` or the core scripts. The orchestrator builds the cores serially. Progress is in `/private/tmp/claude-502/-Users-srikanth--claude-spares-spare-T6CBbW/cc2c1854-ce88-4d54-832c-e613d96219c6/scratchpad/core-builds.log`. Wait for the `ios exit=0` or `android exit=0` line for your platform before building the app.
- Two exceptions, both prebuilt: `mobile/scripts/demo-vault.sh <ios|android>` (seeds a 3.7 MB demo vault) and `target/debug/centraid-gateway` (wave 2 only).
- If you need Rust rebuilt, stop and say so in your report.

## Disk (the owner's hard rule)

- Run `df -g /System/Volumes/Data` before every build and every Maestro batch. Below 30 GiB free: stop and report. Measure with `df`, not `du`.
- Evidence cap: 250 MB for your lane directory. One screenshot per case, as JPEG (`sips -s format jpeg -s formatOptions 60 in.png --out out.jpg`, then delete the PNG). Extra captures only for a FAIL. Video only for the video cases, under 20 seconds.
- Maestro: pass `--test-output-dir` into your lane's scratch area, and after each run delete what Maestro wrote under `~/.maestro/tests`.
- Build outputs go only to the fixed paths in your brief. Delete nothing else on the machine except the scratch you created.
- Never touch the simulator `centraid-1201-review`, its Maestro driver (PID 71858), the AVD dir `centraid-1201-review.avd`, or any other session's worktree. Do not use the Maestro MCP tools (another session owns its port); use the `maestro` CLI.

## Secrets

- Recovery words, pairing payloads and keychain material never go in `reports/`. Keep them in your lane's private scratch dir and delete them when the lane ends. A report may say "24 words shown" but never quote one.
- Do not copy the demo seeder's log into reports; it prints a demo mnemonic.

## Ledger

- Your lane writes `reports/release-qa-2026-11-17/<lane>/coverage.json` and `COVERAGE.md`, updated after every case, so nothing is lost if you are stopped.
- Case id = plan section plus app plus short name (e.g. `J3-docs-trash-restore`, `B4-reminders-direct-trash`). Fields: id, status (PASS, FAIL, BLOCKED, UNRUN, NA), build `99cc70d8f`, platform, theme, text size, evidence path(s), expected (cite the promise, ruling or board), actual.
- A PASS needs an evidence file that shows it. A partial observation is not a PASS. A build or a passing unit test is not a device PASS. Say exactly what you saw.
- Design conformance: compare a screen with its board by structure, words, states and colour, not pixels. iOS is Liquid Glass and Android is M3 Expressive; parity means behaviour and words.

## Reporting back

Each wave ends with a reply of 40 lines at most: counts by status, each FAIL in one line (case id, expected versus actual, evidence path), anything BLOCKED and why, free disk at the start and end, and your lane directory size. Put the detail in the ledger, not in the reply.
