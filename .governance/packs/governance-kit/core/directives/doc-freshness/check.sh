#!/usr/bin/env bash
# Directive: Freshness-tracked docs carry a recent `<!-- last-verified: YYYY-MM-DD -->`
# marker. Mechanical version of the harness-engineering "doc-gardening" practice.
#
# Config: .governance/freshness.conf
#   One path per line, relative to repo root. Blank lines and lines starting with
#   # are ignored. If this file is missing or empty, the directive is a no-op — users
#   explicitly opt docs into freshness tracking.
#
# Default staleness window: 90 days. Override with GOVERNANCE_FRESHNESS_DAYS.
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "doc-freshness"
require_git

ROOT="$(git rev-parse --show-toplevel)"
CONF="$ROOT/.governance/freshness.conf"
MAX_DAYS="${GOVERNANCE_FRESHNESS_DAYS:-90}"

if [[ ! -f "$CONF" ]]; then
    # Nothing opted in. Pass.
    directive_end
fi

now_epoch=$(date +%s)
max_secs=$((MAX_DAYS * 86400))

# Portable ISO-date → epoch. Try GNU then BSD.
iso_to_epoch() {
    local iso="$1"
    date -d "$iso" +%s 2>/dev/null && return 0
    date -j -f "%Y-%m-%d" "$iso" +%s 2>/dev/null && return 0
    return 1
}

while IFS= read -r raw; do
    # Strip comments and whitespace.
    entry="${raw%%#*}"
    entry="${entry#"${entry%%[![:space:]]*}"}"
    entry="${entry%"${entry##*[![:space:]]}"}"
    [[ -z "$entry" ]] && continue

    path="$ROOT/$entry"
    if [[ ! -f "$path" ]]; then
        violation "$entry listed in freshness.conf but does not exist"
        continue
    fi

    # File-level waiver: a comment `governance: allow-doc-freshness <reason>`
    # anywhere in the doc opts the doc out of the staleness check for this
    # commit. Reason required; a bare token does not waive. HTML comment
    # markers are stripped before matching so `<!-- ... -->` does not count
    # as the reason.
    if sed -E 's/<!--//g; s/-->//g' "$path" \
        | grep -qE 'governance:[[:space:]]*allow-doc-freshness[[:space:]]+[^[:space:]]'; then
        continue
    fi

    # Extract the last-verified date. Pattern: <!-- last-verified: YYYY-MM-DD -->
    stamp=$(grep -oE 'last-verified:[[:space:]]*[0-9]{4}-[0-9]{2}-[0-9]{2}' "$path" | head -n1 | awk '{print $NF}')
    if [[ -z "$stamp" ]]; then
        violation "$entry has no '<!-- last-verified: YYYY-MM-DD -->' marker"
        continue
    fi

    stamp_epoch=$(iso_to_epoch "$stamp" || echo "")
    if [[ -z "$stamp_epoch" ]]; then
        violation "$entry has unparseable date '$stamp'"
        continue
    fi

    age=$((now_epoch - stamp_epoch))
    if [[ $age -gt $max_secs ]]; then
        days=$((age / 86400))
        violation "$entry last verified $stamp ($days days ago, max: $MAX_DAYS)"
    fi
done < "$CONF"

directive_end
