#!/usr/bin/env bash
# Runs INSIDE the reactivecircus/android-emulator-runner action for ci.yml's
# `mobile-device-gate` job — the PR device gate (#890 W4). Kept as a committed
# file rather than an inline `script:` block because the action executes inline
# scripts via dash, which choked on multi-line if/else and non-ASCII characters
# (#535). Invoked as `bash apps/mobile/scripts/android-emulator-pr-gate.sh` from
# the repo root.
#
# This lane runs ONLY the critical five. It is deliberately a separate file from
# the roster lane rather than one script with a suite switch: the wiring linter
# derives what each lane schedules by reading the script the lane hands off to,
# and a script holding every branch would make a blocking lane indistinguishable
# from a nightly one. See android-emulator-install.sh's header.
set -euo pipefail

# shellcheck source=apps/mobile/scripts/android-emulator-install.sh
. apps/mobile/scripts/android-emulator-install.sh

export CENTRAID_MOBILE_LANE=pr-gate
# The critical five, short-circuiting on the pairing canary. Budget and the
# reason each member is in it: tests/agent-e2e-mobile/flows/pr-gate-budget.md.
node tests/agent-e2e-mobile/run-pr-gate-suite.mjs
