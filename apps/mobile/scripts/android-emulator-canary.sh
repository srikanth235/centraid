#!/usr/bin/env bash
# Runs INSIDE the reactivecircus/android-emulator-runner action for
# `candidate.yml`'s `mobile-canary-android` job — rung 3, the CANDIDATE (#915).
# (It lived in the deleted `mobile-canary.yml` until Wave 1 moved rung 3 into one
# workflow.) Kept as a
# committed file rather than an inline `script:` block for the same reason as
# its siblings (#535: the action executes inline scripts via dash). Invoked as
# `bash apps/mobile/scripts/android-emulator-canary.sh` from the repo root.
#
# Rung 3 asks one question — is this SHA a build we would hand to a device? — so
# it carries the `resilience` suite (the former PR-gate second leg) and the
# seven `home-apps` covers, and leaves the probes, the Photos seat, the reach
# seat and the promotion pipeline to the nightly. Which suites those are is
# `tests/agent-e2e-mobile/roster.json`'s answer, not this file's: it names a
# rung and a platform, and the roster names the suites.
#
# Separate from android-emulator-roster.sh on purpose — see
# android-emulator-install.sh's header for why the wiring linter needs that.
set -euo pipefail

# shellcheck source=apps/mobile/scripts/android-emulator-install.sh
. apps/mobile/scripts/android-emulator-install.sh

export CENTRAID_MOBILE_LANE="${CENTRAID_MOBILE_LANE:-canary-android}"
# Non-short-circuit across suites: every journey writes evidence even when an
# earlier one fails, so one failure cannot grey the later cells (#535 F4). The
# collection used to be `set +e; ec=0; … || ec=$?` here, one line per suite; it
# moved into run-roster.mjs's `runPlan` when the suite list became roster data.
node tests/agent-e2e-mobile/run-roster.mjs --rung 3 --platform android
