#!/usr/bin/env bash
# Directive: data-runtime-sqlite-separation - centraid handlers may not
# touch runtime.sqlite. Each app has two SQLite files with distinct
# owners:
#   - data.sqlite    -> app-owned, accessed by handlers via ctx.db.
#   - runtime.sqlite -> gateway-owned: chat sessions, agent run ledger,
#                       automation state. Handlers never see it.
#
# A handler that opens or even names runtime.sqlite is a layering
# violation: it reads/writes state the gateway treats as its own and
# would never invalidate via the change-stream. The matching reverse
# rule (gateway core stays out of data.sqlite outside the handler-runner
# / three-tool dispatcher path) is harder to specify statically - there
# are multiple legitimate openers and an allowlist would be brittle.
# Left to code review for now.
#
# Detection: any string literal containing `runtime.sqlite` in any
# tracked **/queries/*.js or **/actions/*.js.
#
# Waiver: `// governance: allow-data-runtime-sqlite-separation <reason>`
# on the offending line. No legitimate case is anticipated today.
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "data-runtime-sqlite-separation"
require_git

# `runtime.sqlite` as a quoted string literal or path fragment. The
# escaped dot keeps incidental words like `runtimesqlite` from matching
# in pathological filenames.
PATTERN='runtime\.sqlite'

while IFS=: read -r file line_no match; do
    [[ -z "$file" ]] && continue
    has_waiver "$file" "$line_no" "data-runtime-sqlite-separation" && continue
    violation "$file:$line_no - handler references runtime.sqlite (handlers only see data.sqlite via ctx.db; runtime.sqlite is gateway-owned)"
done < <(git grep -nE "$PATTERN" -- '**/queries/*.js' '**/actions/*.js' 2>/dev/null || true)

directive_end
