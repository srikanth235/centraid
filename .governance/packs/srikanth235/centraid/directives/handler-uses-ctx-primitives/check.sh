#!/usr/bin/env bash
# Directive: handler-uses-ctx-primitives — centraid handlers (queries/*.js
# and actions/*.js) must not import provider SDKs directly. Inference and
# other gateway-managed capabilities flow through ctx.infer.* / other
# ctx primitives supplied by the handler-runner.
#
# Rationale: handler-as-source-of-truth. Extending ctx.* is the supported
# way to grow capabilities; reaching past it (a) defeats per-profile model
# routing, (b) bypasses run-ledger cost accounting in runtime.sqlite, and
# (c) couples the handler to a specific provider, breaking the embedded ↔
# OpenClaw gateway portability that the architecture is built around.
#
# Detection: import/require of a known provider SDK in any tracked
# queries/*.js or actions/*.js. The forbidden-modules list is explicit
# rather than a wildcard so adding a new provider is a deliberate edit
# here.
#
# Waiver: `// governance: allow-handler-uses-ctx-primitives <reason>` on
# the offending line for the rare opt-in case (e.g. an action that
# legitimately needs to call a provider directly during a controlled
# experiment).
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "handler-uses-ctx-primitives"
require_git

FORBIDDEN_SDKS=(
    '@anthropic-ai/sdk'
    'openai'
    'groq-sdk'
    '@google/generative-ai'
    'cohere-ai'
    '@mistralai/mistralai'
    'replicate'
    'together-ai'
)

# Build an alternation of escaped module names for a single git grep pass.
# Escape regex metacharacters in each SDK name (/, ., -, @).
alt=""
for sdk in "${FORBIDDEN_SDKS[@]}"; do
    esc=$(printf '%s' "$sdk" | sed -e 's/[][\\.*^$/]/\\&/g')
    if [[ -z "$alt" ]]; then alt="$esc"; else alt="${alt}|${esc}"; fi
done

# Match both ESM (`from '<sdk>'`) and CJS (`require('<sdk>')`).
PATTERN="(require\\(|from[[:space:]]+)[\"'](${alt})[\"']"

while IFS=: read -r file line_no match; do
    [[ -z "$file" ]] && continue
    has_waiver "$file" "$line_no" "handler-uses-ctx-primitives" && continue
    # Surface the offending SDK name in the message for easy triage.
    sdk_name=$(printf '%s' "$match" | sed -E "s/.*[\"'](.*)[\"'].*/\\1/")
    violation "$file:$line_no — handler imports provider SDK '$sdk_name' (use ctx.infer.* / gateway-supplied primitives)"
done < <(git grep -nE "$PATTERN" -- '**/queries/*.js' '**/actions/*.js' 2>/dev/null || true)

directive_end
