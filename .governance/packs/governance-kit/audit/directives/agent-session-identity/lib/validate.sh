#!/usr/bin/env bash
# Validator for `## Session` → `### Identifiers` tables.

session_validate_dir() {
    local dir="$1" file
    [ -d "$dir" ] || return 0
    for file in "$dir"/*.md; do
        [ -f "$file" ] || continue
        SESSION_FILE="$file" awk '
function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
function cells(line, c,   n, i) {
    n = split(line, c, "|")
    if (n != 5) return -1
    for (i = 1; i <= 3; i++) c[i] = trim(c[i + 1])
    return 3
}
BEGIN { in_session = 0; in_ids = 0; file = ENVIRON["SESSION_FILE"] }
{
    t = trim($0)
    if (t == "## Session") { in_session = 1; in_ids = 0; next }
    if (in_session && ($0 ~ /^## / || $0 ~ /^# /)) { in_session = 0; in_ids = 0 }
    if (!in_session) next
    if ($0 ~ /^### /) { in_ids = (t == "### Identifiers"); next }
    if (!in_ids || $0 !~ /^[ \t]*\|/) next
    m = cells($0, c)
    if (m < 0) { print file " — session identifier row must have exactly 3 cells: " $0; next }
    if (m == 0 || c[1] == "date" || c[1] ~ /^-+$/ || c[1] == "") next
    if (c[1] !~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]$/) print file " — invalid session date: " $0
    if (c[2] == "") print file " — session row has an empty harness: " $0
    if (c[3] == "") print file " — session row has an empty session identifier: " $0
    key = c[2] SUBSEP c[3]
    if (seen[key]++) print file " — duplicate session identifier " c[2] "/" c[3]
}
' "$file" || true
    done
}
