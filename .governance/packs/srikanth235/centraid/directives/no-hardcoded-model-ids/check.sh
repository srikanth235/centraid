#!/usr/bin/env bash
# Directive: no-hardcoded-model-ids - centraid production code must select
# models by capability tier (e.g. tier:fast / tier:smart), not by concrete
# provider model id. Model lineups churn quickly; tier indirection
# survives.
#
# Allowlist: packages/app-engine/src/model-pricing.ts is the single
# legitimate file that references concrete ids - it is a price table
# keyed by model prefix. Test files (*.test.ts, *.spec.ts) need real ids
# to test the pricing and storage layers, so they are excluded. Markdown
# and dist/ are excluded as documentation / build artifacts.
#
# Patterns matched: known provider model id prefixes (Anthropic Claude,
# OpenAI GPT/o-series, Google Gemini, Mistral/Mixtral, Cohere Command,
# Meta Llama, DeepSeek, Qwen). The list is explicit rather than a
# wildcard so adding a new provider is a deliberate edit here.
#
# Waiver: `// governance: allow-no-hardcoded-model-ids <reason>` on the
# offending line for legitimate exceptions (e.g. a future controlled
# experiment that pins a specific model intentionally).
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "no-hardcoded-model-ids"
require_git

# Known provider model-id prefixes. Each pattern is anchored inside a
# string literal (single or double quotes) to keep false positives down -
# bare identifiers in comments or var names are not flagged.
PATTERN='["'"'"']('
PATTERN+='claude-(opus|sonnet|haiku|3|4)'
PATTERN+='|gpt-[0-9]'
PATTERN+='|o[1-9]-(mini|preview|pro)'
PATTERN+='|gemini-[0-9]'
PATTERN+='|mistral-(large|small|medium|tiny|nemo)'
PATTERN+='|mixtral-'
PATTERN+='|command-(r|a)'
PATTERN+='|llama-[0-9]'
PATTERN+='|meta-llama'
PATTERN+='|deepseek-'
PATTERN+='|qwen-'
PATTERN+=')'

while IFS=: read -r file line_no match; do
    [[ -z "$file" ]] && continue
    has_waiver "$file" "$line_no" "no-hardcoded-model-ids" && continue
    # Extract the matched model id from the line for the violation message.
    model_id=$(printf '%s' "$match" | grep -oE "$PATTERN" | head -1 | tr -d '"'"'")
    violation "$file:$line_no - hardcoded model id '$model_id' (use capability-tier resolver; only packages/app-engine/src/model-pricing.ts is allowlisted)"
done < <(git grep -nE "$PATTERN" -- \
    'packages/**/*.ts' 'packages/**/*.tsx' 'packages/**/*.js' 'packages/**/*.jsx' \
    'apps/**/*.ts' 'apps/**/*.tsx' 'apps/**/*.js' 'apps/**/*.jsx' \
    ':!**/*.test.ts' ':!**/*.test.tsx' ':!**/*.spec.ts' ':!**/*.spec.tsx' \
    ':!**/dist/**' ':!**/node_modules/**' \
    ':!packages/app-engine/src/model-pricing.ts' \
    2>/dev/null || true)

directive_end
