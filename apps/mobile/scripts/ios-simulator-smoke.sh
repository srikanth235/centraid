#!/usr/bin/env bash
# The rung-3 iOS lane (#915 Wave 2) — `candidate.yml`'s `mobile-ios-smoke`.
# Invoked as `bash apps/mobile/scripts/ios-simulator-smoke.sh` from the repo
# root, after the job has booted the pinned simulator and restored the shell
# cache.
#
# Kept as a committed file for the same two reasons its Android siblings are:
# the shipped script is what `scripts/lint-e2e-wiring.mjs` reads to derive what
# this lane schedules, and one script per lane shape is what keeps a blocking
# lane distinguishable from a candidate one. The rung and the platform are on
# the command line, not in an environment variable, because a runner that picked
# its suite from the environment would make every lane look identical to that
# linter — see android-emulator-install.sh's header.
#
# EVERY CANDIDATE CARRIES AN iOS VERDICT (#915 Wave 2's exit criterion). Ten
# minutes warm; the shell is restored by native fingerprint and this SHA's JS is
# injected into it, so no compilation is inside this lane's clock. Members and
# budget: tests/agent-e2e-mobile/roster.json plus flows/ios-smoke-budget.md.
set -euo pipefail

# shellcheck source=apps/mobile/scripts/ios-simulator-install.sh
. apps/mobile/scripts/ios-simulator-install.sh

export CENTRAID_MOBILE_LANE=mobile-ios-smoke
node tests/agent-e2e-mobile/run-roster.mjs --rung 3 --platform ios --suite ios-smoke
