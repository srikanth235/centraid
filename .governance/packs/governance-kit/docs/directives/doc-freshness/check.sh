#!/usr/bin/env bash
# Directive: Freshness-tracked docs carry a recent `<!-- last-verified: YYYY-MM-DD -->`
# marker. Mechanical version of the harness-engineering "doc-gardening" practice.
#
# Config: .governance/conf/governance-kit/docs/doc-freshness.conf
#   Rule lines are one path per line, relative to repo root. Blank lines and
#   lines starting with # are ignored. If this file is missing or empty, the
#   directive is a no-op — users explicitly opt docs into freshness tracking.
#
# Staleness window: the FRESHNESS_DAYS default lives in the pack-owned
# `defaults.conf` beside this script. Override with a `FRESHNESS_DAYS=` line in
# the overlay, or the GOVERNANCE_FRESHNESS_DAYS env var (env wins).
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "doc-freshness"
require_git

DEFAULTS="$(dirname "$0")/defaults.conf"
[[ -f "$DEFAULTS" ]] || { violation "broken install: $DEFAULTS missing (FRESHNESS_DAYS default unavailable)"; directive_end; }

ROOT="$(git rev-parse --show-toplevel)"
MAX_DAYS="$(conf_get doc-freshness FRESHNESS_DAYS "$DEFAULTS")"

if ! conf_file doc-freshness >/dev/null; then
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

# conf_rule_lines yields the trimmed, comment-free path lines and skips any
# `KEY=value` scalar settings (e.g. FRESHNESS_DAYS).
while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue

    path="$ROOT/$entry"
    if [[ ! -f "$path" ]]; then
        violation "$entry listed in doc-freshness config but does not exist"
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
done < <(conf_rule_lines doc-freshness)

directive_end
