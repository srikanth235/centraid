#!/usr/bin/env bash
# Runs INSIDE the reactivecircus/android-emulator-runner action for ci.yml's
# `mobile-device-gate` job — the RESILIENCE leg of the PR device gate (#905).
# Sibling of android-emulator-pr-gate.sh, which is the paired leg; the two run
# on two emulators in parallel because the five members measured ~795s in
# sequence against a 720s deadline. One script per leg, for the same reason
# there is one script per lane shape: see android-emulator-install.sh's header.
set -euo pipefail

# shellcheck source=apps/mobile/scripts/android-emulator-install.sh
. apps/mobile/scripts/android-emulator-install.sh

# The lane label stays `pr-gate` for both legs — the ledger keys by flow and
# platform, and the two legs are one gate.
export CENTRAID_MOBILE_LANE=pr-gate
# The canary, then the two resilience members. Budget and the reason each member
# is in it: tests/agent-e2e-mobile/flows/pr-gate-budget.md.
node tests/agent-e2e-mobile/run-pr-gate-resilience-suite.mjs
