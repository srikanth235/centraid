#!/usr/bin/env bash
# Directive: handler-contract — the four rules that keep a centraid app
# handler inside its contract: it reads and writes only the app's own
# data.sqlite through ctx.*, and every mutation is visible to the
# change-notification SSE feed at /centraid/<id>/_changes.
#
# The sub-checks were four separate directives (query-handlers-read-only,
# actions-declare-table-writes, data-runtime-sqlite-separation, and
# handler-uses-ctx-primitives). They scan the same file set, share one
# rationale, and none is a load-bearing axis on its own — the same reason
# governance-kit ships repo-hygiene and required-docs as single directives.
#
# Sub-checks:
#   query-read-only    — no stmt.run()/db.exec() in queries/*.js|ts. The
#                        handler runner skips session tracking for
#                        handlerKind === 'query' (handler-runner.ts), so a
#                        write there succeeds while the bus stays silent.
#   declared-writes    — every app.json#actions[] entry declares writes:[].
#                        The change stream uses it to invalidate per-table
#                        query subscriptions; a missing field silently
#                        breaks invalidation.
#   sqlite-separation  — no runtime.sqlite reference in handlers.
#                        runtime.sqlite is gateway-owned (conversation
#                        ledger, automation state); handlers see only
#                        data.sqlite via ctx.db.
#   ctx-primitives     — no direct provider-SDK import. Provider work flows
#                        through ctx.delegate so per-profile routing and
#                        run-ledger cost accounting cannot be bypassed.
#
# Waiver: `// governance: allow-handler-contract <reason>` on the offending
# line. The four retired per-directive tokens are still honoured so an
# existing waiver keeps working without a migration commit. The
# declared-writes sub-check takes no waiver: JSON has no comment syntax, and
# the right opt-out for a no-DB-write action is the explicit empty array.
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "handler-contract"
require_git

HANDLER_PATHS=('**/queries/*.js' '**/queries/*.ts' '**/actions/*.js' '**/actions/*.ts')
QUERY_PATHS=('**/queries/*.js' '**/queries/*.ts')

# A line is waived by the directive token or by the token of the directive
# this sub-check was merged from.
handler_waived() {
    local file="$1" line_no="$2" legacy="$3"
    has_waiver "$file" "$line_no" "handler-contract" && return 0
    has_waiver "$file" "$line_no" "$legacy"
}

# ── query-read-only ─────────────────────────────────────────────────────────
# `.run()` is ScopedDb's write API (packages/server/src/engine/types.ts) and
# db.exec() accepts arbitrary SQL including DML/DDL. git grep -E is POSIX ERE
# with no \b, so db.exec is anchored on its `db.` qualifier instead.
while IFS=: read -r file line_no match; do
    [[ -z "$file" ]] && continue
    handler_waived "$file" "$line_no" "query-handlers-read-only" && continue
    if [[ "$match" == *"db.exec("* ]]; then
        violation "query-read-only: $file:$line_no — query handler calls db.exec() (writes are invisible to /_changes; move to actions/)"
    else
        violation "query-read-only: $file:$line_no — query handler calls stmt.run() (writes are invisible to /_changes; move to actions/)"
    fi
done < <(git grep -nE '(\.run\(|db\.exec\()' -- "${QUERY_PATHS[@]}" 2>/dev/null || true)

# ── sqlite-separation ───────────────────────────────────────────────────────
# The escaped dot keeps incidental words like `runtimesqlite` from matching.
while IFS=: read -r file line_no match; do
    [[ -z "$file" ]] && continue
    handler_waived "$file" "$line_no" "data-runtime-sqlite-separation" && continue
    violation "sqlite-separation: $file:$line_no — handler references runtime.sqlite (handlers only see data.sqlite via ctx.db; runtime.sqlite is gateway-owned)"
done < <(git grep -nE 'runtime\.sqlite' -- "${HANDLER_PATHS[@]}" 2>/dev/null || true)

# ── ctx-primitives ──────────────────────────────────────────────────────────
# The forbidden list is explicit rather than a wildcard so adding a provider
# is a deliberate edit here.
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
alt=""
for sdk in "${FORBIDDEN_SDKS[@]}"; do
    esc=$(printf '%s' "$sdk" | sed -e 's/[][\\.*^$/]/\\&/g')
    if [[ -z "$alt" ]]; then alt="$esc"; else alt="${alt}|${esc}"; fi
done

# Match both ESM (`from '<sdk>'`) and CJS (`require('<sdk>')`).
while IFS=: read -r file line_no match; do
    [[ -z "$file" ]] && continue
    handler_waived "$file" "$line_no" "handler-uses-ctx-primitives" && continue
    sdk_name=$(printf '%s' "$match" | sed -E "s/.*[\"'](.*)[\"'].*/\\1/")
    violation "ctx-primitives: $file:$line_no — handler imports provider SDK '$sdk_name' (use ctx.delegate / gateway-supplied primitives)"
done < <(git grep -nE "(require\\(|from[[:space:]]+)[\"'](${alt})[\"']" -- "${HANDLER_PATHS[@]}" 2>/dev/null || true)

# ── declared-writes ─────────────────────────────────────────────────────────
# Walks tracked **/app.json, keeps only Centraid manifests (manifestVersion
# is set — apps/mobile/app.json is an Expo config with the same filename),
# and asserts each action declares an array `writes`. Empty arrays are valid
# and mean "this action performs no DB writes".
if ! command -v jq >/dev/null 2>&1; then
    violation "declared-writes: directive requires jq on PATH (install with 'brew install jq' or system package manager)"
else
    while IFS= read -r file; do
        [[ -z "$file" ]] && continue
        is_centraid=$(jq -r 'if .manifestVersion != null then "yes" else "no" end' "$file" 2>/dev/null || echo "no")
        [[ "$is_centraid" != "yes" ]] && continue

        actions_count=$(jq -r '(.actions // []) | length' "$file" 2>/dev/null || echo 0)
        [[ "$actions_count" == "0" ]] && continue

        while IFS=$'\t' read -r name status; do
            [[ -z "$name" ]] && continue
            case "$status" in
                ok) : ;;
                missing)
                    violation "declared-writes: $file — action '$name' has no 'writes' field (declare 'writes: [\"<table>\", ...]' or 'writes: []' for no-DB-write actions)"
                    ;;
                not-array)
                    violation "declared-writes: $file — action '$name' has non-array 'writes' field (must be an array of table names)"
                    ;;
                *)
                    violation "declared-writes: $file — action '$name' writes-field check returned unexpected status '$status'"
                    ;;
            esac
        done < <(jq -r '
            .actions[]
            | (.name // "<unnamed>") as $name
            | if (.writes // null) == null then
                "\($name)\tmissing"
              elif (.writes | type) != "array" then
                "\($name)\tnot-array"
              else
                "\($name)\tok"
              end
        ' "$file" 2>/dev/null || true)
    done < <(git ls-files -- '**/app.json' 2>/dev/null || true)
fi

directive_end
