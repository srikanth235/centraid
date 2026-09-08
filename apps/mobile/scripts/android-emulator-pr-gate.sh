#!/usr/bin/env bash
# Runs INSIDE the reactivecircus/android-emulator-runner action for ci.yml's
# `mobile-device-gate` job — the PR device gate, rung 2 of the ladder (#915).
# Kept as a committed file rather than an inline `script:` block because the
# action executes inline scripts via dash, which choked on multi-line if/else
# and non-ASCII characters (#535). Invoked as
# `bash apps/mobile/scripts/android-emulator-pr-gate.sh` from the repo root.
#
# ONE LEG, ONE EMULATOR, EIGHT MINUTES WARM (#915 Wave 1). It used to be two
# legs of the critical five; `native-v0-resilience` and `photos-permissions`
# answer a post-merge question and now run on rungs 3 and 4, which is why the
# sibling `android-emulator-pr-gate-resilience.sh` is gone.
#
# THE RUNG AND THE SUITE ARE ON THE COMMAND LINE, not in an env var, and this
# is still one script per lane shape. `scripts/lint-e2e-wiring.mjs` derives what
# each lane schedules by reading the invocation the shipped script contains, and
# resolves `--rung/--platform/--suite` through `tests/agent-e2e-mobile/lib/roster.mjs`.
# A script that branched on an environment variable would make a blocking lane
# indistinguishable from a nightly one, which is exactly what its `promoting`
# and `exploratory` rules depend on. See android-emulator-install.sh's header.
set -euo pipefail

# shellcheck source=apps/mobile/scripts/android-emulator-install.sh
. apps/mobile/scripts/android-emulator-install.sh

export CENTRAID_MOBILE_LANE=pr-gate
# The rung-2 suite. Members, budget and the reason each member is in it:
# tests/agent-e2e-mobile/roster.json plus flows/pr-gate-budget.md.
node tests/agent-e2e-mobile/run-roster.mjs --rung 2 --platform android --suite pr-gate
