#!/usr/bin/env bash
# Runs INSIDE the reactivecircus/android-emulator-runner action for the two
# full-roster Android lanes — `mobile-canary.yml`'s per-merge canary and
# `e2e.yml`'s nightly. Kept as a committed file rather than an inline `script:`
# block because the action executes inline scripts via dash, which choked on
# multi-line if/else and non-ASCII characters (#535). Invoked as
# `bash apps/mobile/scripts/android-emulator-roster.sh` from the repo root.
#
# Separate from android-emulator-pr-gate.sh on purpose — see
# android-emulator-install.sh's header for why the wiring linter needs that.
set -euo pipefail

# shellcheck source=apps/mobile/scripts/android-emulator-install.sh
. apps/mobile/scripts/android-emulator-install.sh

# Non-short-circuit: every journey writes evidence even when an earlier one
# fails, so one failure cannot grey the later cells (#535 F4). The PR gate is the
# one lane that breaks this rule, and only for its pairing canary, because there
# the later cells would be greyed by a prerequisite and would name it wrongly.
#
# #890 W0 wrapped the six formerly bare `node …` lines in run-probes-suite.mjs so
# the standalone journeys carry an aggregate budget like the two seated suites do
# (Grid G showed them unbudgeted), and scheduled sharing-invite.mjs, which
# tests/matrix.json named three times as an evidence owner while nothing ran it.
export CENTRAID_MOBILE_LANE="${CENTRAID_MOBILE_LANE:-nightly-android}"
set +e
ec=0
node tests/agent-e2e-mobile/run-probes-suite.mjs || ec=$?
node tests/agent-e2e-mobile/run-photos-suite.mjs || ec=$?
node tests/agent-e2e-mobile/run-home-apps-suite.mjs || ec=$?
node tests/agent-e2e-mobile/flows/sharing-invite.mjs || ec=$?
set -e
exit "$ec"
