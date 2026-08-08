#!/usr/bin/env bash
# Markdown plumbing for the receipt's session-identifier table.

SESSION_NOTE='<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->'
SESSION_SUBHEADING='### Identifiers'
SESSION_HEADER='| date | harness | session |'
SESSION_SEPARATOR='| --- | --- | --- |'

receipt_safe_cell() {
    local s="$1" max="${2:-160}"
    s="$(printf '%s' "$s" | tr -d '|' | tr -d '\000-\037\177')"
    s="${s%%\\*}"
    s="${s#"${s%%[![:space:]]*}"}"
    s="${s%"${s##*[![:space:]]}"}"
    printf '%s' "${s:0:$max}"
}

receipt_resolve() {
    local dir="$1" n="${2#\#}" f base match="" match_base=""
    local LC_ALL=C
    if [ -d "$dir" ]; then
        for f in "$dir"/issue-"$n".md "$dir"/issue-"$n"-*.md; do
            [ -f "$f" ] || continue
            base="$(basename "$f")"
            printf '%s' "$base" | grep -qE "^issue-$n(-[a-z0-9]+)*\\.md$" || continue
            if [ -z "$match" ] || [[ "$base" < "$match_base" ]]; then
                match="$f"; match_base="$base"
            fi
        done
    fi
    if [ -n "$match" ]; then printf '%s\n' "$match"; else printf '%s/issue-%s.md\n' "$dir" "$n"; fi
}

session_rows() {
    local file="$1"
    [ -f "$file" ] || return 0
    awk '
function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
function cells(line, c,   n, i) {
    n = split(line, c, "|")
    if (n != 5) return -1
    for (i = 1; i <= 3; i++) c[i] = trim(c[i + 1])
    return 3
}
BEGIN { in_session = 0; in_ids = 0 }
{
    t = trim($0)
    if (t == "## Session") { in_session = 1; in_ids = 0; next }
    if (in_session && ($0 ~ /^## / || $0 ~ /^# /)) { in_session = 0; in_ids = 0 }
    if (!in_session) next
    if ($0 ~ /^### /) { in_ids = (t == "### Identifiers"); next }
    if (in_ids && $0 ~ /^[ \t]*\|/) {
        m = cells($0, c)
        if (m == 3 && c[1] != "date" && c[1] !~ /^-+$/ && c[1] != "") print $0
    }
}
' "$file"
}

session_row() {
    local file="$1" harness="$2" session="$3"
    SESSION_HARNESS="$harness" SESSION_ID="$session" awk '
function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
function cells(line, c,   n, i) {
    n = split(line, c, "|")
    if (n != 5) return -1
    for (i = 1; i <= 3; i++) c[i] = trim(c[i + 1])
    return 3
}
BEGIN { want_h = ENVIRON["SESSION_HARNESS"]; want_s = ENVIRON["SESSION_ID"] }
{ if (cells($0, c) == 3 && c[2] == want_h && c[3] == want_s) { print $0; exit } }
' < <(session_rows "$file")
}

session_upsert() {
    local file="$1" date="$2" harness="$3" session="$4" row tmp
    mkdir -p "$(dirname "$file")"
    [ -f "$file" ] || : > "$file"
    date="$(receipt_safe_cell "$date" 10)"
    harness="$(receipt_safe_cell "$harness" 80)"
    session="$(receipt_safe_cell "$session" 160)"
    row="| $date | $harness | $session |"
    tmp="$file.gk-tmp.$$"
    SESSION_ROW="$row" SESSION_HARNESS="$harness" SESSION_ID="$session" \
    SESSION_NOTE="$SESSION_NOTE" SESSION_SUB="$SESSION_SUBHEADING" \
    SESSION_HEADER="$SESSION_HEADER" SESSION_SEP="$SESSION_SEPARATOR" awk '
function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
function cells(line, c,   n, i) {
    n = split(line, c, "|")
    if (n != 5) return -1
    for (i = 1; i <= 3; i++) c[i] = trim(c[i + 1])
    return 3
}
BEGIN { row = ENVIRON["SESSION_ROW"]; want_h = ENVIRON["SESSION_HARNESS"]; want_s = ENVIRON["SESSION_ID"] }
{ lines[++n] = $0 }
END {
    start = 0
    for (i = 1; i <= n; i++) if (trim(lines[i]) == "## Session") { start = i; break }
    if (start == 0) {
        if (n > 0 && trim(lines[n]) != "") lines[++n] = ""
        lines[++n] = "## Session"; lines[++n] = ""; lines[++n] = ENVIRON["SESSION_NOTE"]
        lines[++n] = ""; lines[++n] = ENVIRON["SESSION_SUB"]
        lines[++n] = ""; lines[++n] = ENVIRON["SESSION_HEADER"]
        lines[++n] = ENVIRON["SESSION_SEP"]; lines[++n] = row
        for (i = 1; i <= n; i++) print lines[i]
        exit
    }
    end = n + 1
    for (i = start + 1; i <= n; i++) if (lines[i] ~ /^## / || lines[i] ~ /^# /) { end = i; break }
    ids = 0
    for (i = start + 1; i < end; i++) if (trim(lines[i]) == ENVIRON["SESSION_SUB"]) { ids = i; break }
    if (ids == 0) {
        for (i = start + 1; i < end; i++) if (trim(lines[i]) != "") last = i
        ins = (last ? last + 1 : start + 1)
        for (i = 1; i < ins; i++) print lines[i]
        if (ins > 1 && trim(lines[ins - 1]) != "") print ""
        print ENVIRON["SESSION_SUB"]; print ""; print ENVIRON["SESSION_HEADER"]; print ENVIRON["SESSION_SEP"]; print row
        for (i = ins; i <= n; i++) print lines[i]
        exit
    }
    replaced = 0; insert_at = end
    for (i = ids + 1; i < end; i++) {
        if (lines[i] ~ /^[ \t]*\|/) {
            m = cells(lines[i], c)
            if (m == 3 && c[1] != "date" && c[1] !~ /^-+$/ && c[2] == want_h && c[3] == want_s) {
                lines[i] = row; replaced = 1
            }
            insert_at = i + 1
        }
    }
    if (!replaced) { for (i = n; i >= insert_at; i--) lines[i + 1] = lines[i]; lines[insert_at] = row; n++ }
    for (i = 1; i <= n; i++) print lines[i]
}
' "$file" > "$tmp" && mv "$tmp" "$file"
}
