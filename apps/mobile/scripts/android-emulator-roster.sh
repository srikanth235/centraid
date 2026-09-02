#!/usr/bin/env bash
# Runs INSIDE the reactivecircus/android-emulator-runner action for `e2e.yml`'s
# nightly Android lane — rung 4, DEPTH (#915). Kept as a committed file rather
# than an inline `script:` block because the action executes inline scripts via
# dash, which choked on multi-line if/else and non-ASCII characters (#535).
# Invoked as `bash apps/mobile/scripts/android-emulator-roster.sh` from the repo
# root.
#
# Rung 4 is everything the candidate rung does not have the 45 minutes for: the
# probes, the Photos seat, the seven home-app covers a second time against a
# tree nobody just pushed to, the reach seat, and the D3 promotion pipeline.
# WHICH suites those are is `tests/agent-e2e-mobile/roster.json`'s answer — this
# file names a rung and a platform. The five `node …` lines it used to carry,
# and the bare `flows/sharing-reach.mjs` invocation among them (the one journey
# on the roster that no suite priced), are roster rows now.
#
# Separate from android-emulator-canary.sh and android-emulator-pr-gate.sh on
# purpose — see android-emulator-install.sh's header for why the wiring linter
# needs one script per lane shape.
set -euo pipefail

# shellcheck source=apps/mobile/scripts/android-emulator-install.sh
. apps/mobile/scripts/android-emulator-install.sh

# Non-short-circuit: every journey writes evidence even when an earlier one
# fails, so one failure cannot grey the later cells (#535 F4). The PR gate is
# the one lane that breaks this rule, and only for its pairing canary, because
# there the later cells would be greyed by a prerequisite and would name it
# wrongly. The per-suite exit-code collection this file used to spell as
# `set +e; ec=0; … || ec=$?` now lives in run-roster.mjs's `runPlan`, so the
# semantics are the same and there is one copy of them.
#
# The D3 promotion pipeline runs here and only here: both non-blocking Android
# lanes may carry a `promoting` flow, the PR gate never does, and that asymmetry
# is the rule `scripts/lint-e2e-wiring.mjs` enforces.
export CENTRAID_MOBILE_LANE="${CENTRAID_MOBILE_LANE:-nightly-android}"
node tests/agent-e2e-mobile/run-roster.mjs --rung 4 --platform android
