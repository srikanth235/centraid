#!/usr/bin/env bash
# Directive: actions-declare-table-writes - every centraid app manifest
# (app.json with manifestVersion) must declare a writes:[] field on each
# action[]. The change-stream SSE feed at /centraid/<id>/_changes uses
# this metadata to invalidate per-table query subscriptions. A missing
# or non-array writes field is the same foot-gun shape as the existing
# query-handlers-read-only directive: the mutation succeeds, the bus
# stays silent, subscribed iframes never re-fetch, UI goes silently
# stale with no error.
#
# Detection: walks every tracked **/app.json, filters to Centraid
# manifests (those with manifestVersion set - distinguishes from Expo's
# apps/mobile/app.json which uses the same filename), and for each entry
# in .actions[] asserts .writes exists and is an array. Empty arrays are
# allowed - they signal "this action performs no DB writes" (e.g. an
# action that only sends a webhook).
#
# No per-line waivers: JSON has no comment syntax, and the check is
# file-level. If an action genuinely needs to opt out, fix the manifest
# to declare writes:[].
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "actions-declare-table-writes"
require_git

command -v jq >/dev/null 2>&1 || {
    violation "directive requires jq on PATH (install with 'brew install jq' or system package manager)"
    directive_end
    return
}

while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    # Only inspect Centraid app manifests. Expo's apps/mobile/app.json has
    # the same filename but no manifestVersion field, so we skip it.
    is_centraid=$(jq -r 'if .manifestVersion != null then "yes" else "no" end' "$file" 2>/dev/null || echo "no")
    [[ "$is_centraid" != "yes" ]] && continue

    # No actions array, or zero actions - nothing to check.
    actions_count=$(jq -r '(.actions // []) | length' "$file" 2>/dev/null || echo 0)
    [[ "$actions_count" == "0" ]] && continue

    # Emit one line per action with its writes-field status.
    while IFS=$'\t' read -r name status; do
        [[ -z "$name" ]] && continue
        case "$status" in
            ok)
                : # writes is a valid array
                ;;
            missing)
                violation "$file - action '$name' has no 'writes' field (declare 'writes: [\"<table>\", ...]' or 'writes: []' for no-DB-write actions)"
                ;;
            not-array)
                violation "$file - action '$name' has non-array 'writes' field (must be an array of table names)"
                ;;
            *)
                violation "$file - action '$name' writes-field check returned unexpected status '$status'"
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

directive_end
