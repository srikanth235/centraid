#!/usr/bin/env bash
# governance-kit:managed kit-version=0.12.0
# Shared helpers for governance directive tests.
# Source this from every directive's check.sh. Packs always live two levels
# deep, so directives at `.governance/packs/<owner>/<name>/directives/<id>/check.sh`
# reach lib.sh with five `..` segments:
#   source "$(dirname "$0")/../../../../../lib.sh"

set -u

# Color output only when stdout is a terminal AND terminfo reports a usable
# palette. Using tput (rather than raw \033[…] escapes) means TERM=dumb and
# stripped CI shells get empty strings — no ANSI garbage in logs. tput ships
# with ncurses on macOS and every mainstream Linux, so no new deps.
if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && tput setaf 1 >/dev/null 2>&1; then
    readonly C_RED=$(tput setaf 1)
    readonly C_GREEN=$(tput setaf 2)
    readonly C_YELLOW=$(tput setaf 3)
    readonly C_BOLD=$(tput bold)
    readonly C_RESET=$(tput sgr0)
else
    readonly C_RED=""
    readonly C_GREEN=""
    readonly C_YELLOW=""
    readonly C_BOLD=""
    readonly C_RESET=""
fi

# Track violations for the current directive. Each directive should call
# `directive_start` at the top, then `violation` for each problem found, then
# `directive_end` at the bottom. `directive_end` exits 0 if no violations,
# 1 otherwise.
_DIRECTIVE_NAME=""
_VIOLATION_COUNT=0
_VIOLATIONS=()

directive_start() {
    _DIRECTIVE_NAME="$1"
    _VIOLATION_COUNT=0
    _VIOLATIONS=()
}

violation() {
    _VIOLATION_COUNT=$((_VIOLATION_COUNT + 1))
    _VIOLATIONS+=("$1")
}

directive_end() {
    if [[ $_VIOLATION_COUNT -eq 0 ]]; then
        printf "%s✓%s %s\n" "$C_GREEN" "$C_RESET" "$_DIRECTIVE_NAME"
        exit 0
    fi
    printf "%s✗ %s%s (%d violation%s)\n" "$C_RED" "$_DIRECTIVE_NAME" "$C_RESET" \
        "$_VIOLATION_COUNT" "$([[ $_VIOLATION_COUNT -eq 1 ]] || echo s)"
    for v in "${_VIOLATIONS[@]}"; do
        printf "    %s\n" "$v"
    done
    # Surface the directive's rationale at the moment of violation. The
    # constitution subsection sits beside check.sh; pull the `**Rationale**:`
    # field, joining any wrapped continuation lines into one. Absent file or
    # field → print nothing (community packs needn't ship a constitution.md).
    local constitution rationale
    constitution="$(dirname "$0")/constitution.md"
    if [[ -f "$constitution" ]]; then
        rationale="$(awk '
            /^[[:space:]]*-?[[:space:]]*\*\*Rationale\*\*:/ {
                sub(/^.*\*\*Rationale\*\*:[[:space:]]*/, ""); buf=$0; cap=1; next
            }
            cap {
                if ($0 ~ /^[[:space:]]*$/ || $0 ~ /^[[:space:]]*-[[:space:]]*\*\*/ || $0 ~ /^#/) exit
                line=$0; sub(/^[[:space:]]+/, "", line); buf=buf " " line
            }
            END { print buf }
        ' "$constitution")"
        if [[ -n "$rationale" ]]; then
            printf "\n    %sRationale:%s %s\n" "$C_YELLOW" "$C_RESET" "$rationale"
        fi
    fi
    exit 1
}

# Emit tracked files (respects .gitignore), optionally filtered by a pathspec.
# Usage: tracked_files                → all tracked files
#        tracked_files '*.py'         → all tracked .py files
#        tracked_files ':!vendor/**'  → all tracked files excluding vendor/
tracked_files() {
    if [[ $# -eq 0 ]]; then
        git ls-files
    else
        git ls-files "$@"
    fi
}

# Exit with skip status if we're not inside a git working tree.
require_git() {
    if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
        printf "%s⊘%s %s (not a git repo — skipped)\n" \
            "$C_YELLOW" "$C_RESET" "$_DIRECTIVE_NAME"
        exit 0
    fi
}

# Allow in-source waivers. Directives that support exceptions should grep for
# `governance: allow-<directive-name>` on the violating line and skip it.
# Example: `foo = "AKIA..."  # governance: allow-secrets-hygiene TICKET-123`
has_waiver() {
    local file="$1" line_no="$2" directive="$3"
    sed -n "${line_no}p" "$file" | grep -q "governance: allow-${directive}"
}

# File-level waiver — for sub-checks where the violation is the file itself
# (not a specific line), scan the first 10 lines for a head-of-file token.
# A sub-check name is required so multiple file-level sub-checks can share
# the same `allow-<directive>` prefix without colliding.
# Example: `// governance: allow-repo-hygiene file-size-limit TICKET-123`
has_file_waiver() {
    local file="$1" directive="$2" subcheck="$3"
    [[ -f "$file" ]] || return 1
    head -n 10 "$file" 2>/dev/null \
        | grep -q "governance: allow-${directive} ${subcheck}"
}

# ── Sub-agent attestation sections (issues #271, #272) ──────────────────────
# Some directives need a section a *fresh-context sub-agent* must populate — one
# that read ground truth (the diff, the issue) the code-author's reasoning never
# contaminated. That independence is the author≠auditor split happening at
# author-time. A pre-commit hook can neither spawn a sub-agent nor judge its
# output, so these directives follow the standard GDD remediation loop:
#   * check.sh enforces only that the section is PRESENT and carries a verdict;
#   * when it is missing, the *violation message is the authoring instruction* —
#     the harness agent reads it, spawns the sub-agent, the sub-agent writes the
#     section, the commit is retried;
#   * the hook never spawns anything, and a bare/CI commit with no agent simply
#     hard-fails on the missing section (correct — the audit step did not run).
# check.sh can demand the attestation's PRESENCE, never manufacture or verify
# its CONTENT; re-deriving the recorded verdict is the merge-time sweep lane's
# job (deferred, out of scope here). These helpers are the shared infra so any
# directive — not just one — can gate an attestation section the same way.

# extract_md_section <file> <heading>
#   Print the body of the `## <heading>` section (case-insensitive heading
#   match), stopping at the next `## ` heading. The generic markdown-section
#   reader shared by directives that inspect a named section.
extract_md_section() {
    local file="$1" heading="$2"
    awk -v h="$heading" '
        BEGIN { in_section = 0 }
        /^##[[:space:]]+/ {
            if (in_section) exit
            line = $0
            sub(/^##[[:space:]]+/, "", line)
            sub(/[[:space:]]+$/, "", line)
            if (tolower(line) == tolower(h)) {
                in_section = 1
                next
            }
        }
        { if (in_section) print }
    ' "$file"
}

# _tier_phrase <tier>
#   The model-capability phrase rendered into a sub-agent authoring instruction,
#   keyed by the attest/sweep capability TIER (not a model id, issue #142). The
#   commit lane runs the bounded read-and-record audit on the cheap tier by
#   default (issue #321); a consumer raises it per-repo via the SUBAGENT_TIERS_*
#   conf knobs (issue #331), and this phrase keeps the instruction honest about
#   which tier was requested. Unknown tiers degrade to the low phrasing.
_tier_phrase() {
    case "$1" in
        high)
            printf 'a capable model (the high capability tier, e.g. Claude Opus or Sonnet, or a comparable frontier model)' ;;
        medium)
            printf 'a mid-capability model (the medium capability tier)' ;;
        low | *)
            printf 'a small, low-cost model (the low capability tier; for Codex use a mini-class model, for Claude Code use a Haiku-class model; this is a bounded read-and-record audit whose verdict is independently re-derived by the merge-time sweep lane)' ;;
    esac
}

# attestation_prompt <section> <inputs> <check-1> [<check-2> ...]
#   Print the canonical sub-agent authoring instruction. One envelope so every
#   attestation-backed directive emits the same recognizable instruction; the
#   directive supplies only what varies — the section name, the <inputs> the
#   sub-agent must be handed, and the numbered checks it must adjudicate.
#   The envelope asks for a small, low-cost model (low capability tier): this is
#   the fallback path (`require_attestation`), which carries no operator tier
#   knob, so it always names the low tier. The declaration-driven gate
#   (`subagent_attest`/`attestation_remediation`) renders the conf-resolved
#   attest tier instead (issue #331).
attestation_prompt() {
    local section="$1" inputs="$2"
    shift 2
    local numbered="" i=1
    local c
    for c in "$@"; do
        numbered+="($i) ${c}; "
        i=$((i + 1))
    done
    numbered="${numbered%; }"
    printf 'Spawn a fresh-context sub-agent — on %s — with exactly these inputs — %s — and have it report a verdict + evidence for each, rendering each verdict as exactly the token PASS or REFUTED: %s. Default to REFUTED if uncertain. Write the findings into a '\''## %s'\'' section, then re-stage and re-commit. The hook never spawns the sub-agent itself; do not self-author this section in the primary agent context.' \
        "$(_tier_phrase low)" "$inputs" "$numbered" "$section"
}

# require_attestation <file> <section> <why> <inputs> <check-1> [<check-2> ...]
#   The deterministic gate. Records a `violation` when <file> lacks a
#   well-formed `## <section>`:
#     * absent          → <why> + the attestation_prompt authoring instruction;
#     * present but with no PASS/REFUTED verdict → a "fill in the verdict"
#       message.
#   Returns 0 when the section is well-formed, 1 otherwise (callers may branch).
#   Purely mechanical: presence + a verdict token, never the verdict's truth.
require_attestation() {
    local file="$1" section="$2" why="$3" inputs="$4"
    shift 4
    if ! grep -qE "^##[[:space:]]+${section}\b" "$file"; then
        violation "$file — missing a '## ${section}' section. ${why} $(attestation_prompt "$section" "$inputs" "$@")"
        return 1
    fi
    local body
    body="$(extract_md_section "$file" "$section")"
    if ! printf '%s\n' "$body" | grep -qiE '\b(PASS|REFUTED)\b'; then
        violation "$file — '## ${section}' section records no PASS/REFUTED verdict; the sub-agent must report a verdict + evidence for each check this directive names."
        return 1
    fi
    return 0
}

# ── Sub-agent judgment: one declaration, batched orchestration (issue #325) ──
# Attestation (commit-time) and the sweep lane (merge/scheduled) are the same
# judgment task at two tiers and two times. A directive declares that task ONCE,
# in a `subagent:` block in its directive.yaml:
#
#   subagent:
#     inputs:  [diff, receipt, issue]   # typed tokens → the handles the judge gets
#     checks:
#       - "every '- [x]' item is realized in the diff"
#       - "the '## Checklist' mirrors the issue's checklist"
#     isolation: shared                 # shared (default) | isolated
#     section: Audit                    # the receipt section the verdict lands in
#     tiers:   { attest: low, sweep: high }
#
# The commit-mode consumer (attest) is two pieces, and `require_attestation`
# above stays exactly as the per-directive presence+verdict gate:
#   * `subagent_attest <receipt>` is the gate a migrated check.sh calls. It reads
#     the sibling directive.yaml's `subagent:` block, runs the same presence +
#     PASS/REFUTED check (so CI still fails per-section, independently), and when
#     the section is pending REGISTERS it into a shared ledger.
#   * `attestation_remediation` is the orchestrator. run.sh / the pre-commit
#     dispatcher runs it ONCE after every check.sh; it reads the ledger and emits
#     a single grouped remediation instruction — one sub-agent for all
#     `isolation: shared` sections (handed the union of their inputs), plus one
#     isolated sub-agent per `isolation: isolated` section. Worst case (all
#     isolated) = one spawn per section, as before; best case (all shared) = one
#     spawn per commit.
# The author≠auditor independence (the auditor is always a fresh context, never
# the harness) is preserved in every case; only inter-attestation independence is
# traded by batching, which a directive opts out of with `isolation: isolated`.

# _subagent_yaml <directive.yaml> <key>
#   Print the value(s) of `subagent.<key>`. List keys (inputs, checks) print one
#   item per line; scalar keys (section, isolation) print a single line; absent →
#   nothing. Stdlib python parses only the constrained block shape above (flow
#   `[a, b]` or block `- a` lists; bare scalars) — no PyYAML dependency.
_subagent_yaml() {
    python3 - "$1" "$2" <<'PY'
import sys
path, key = sys.argv[1], sys.argv[2]
try:
    raw = open(path, encoding="utf-8").read().splitlines()
except OSError:
    sys.exit(0)

# Locate the top-level `subagent:` key and slice its indented block.
start = None
for i, ln in enumerate(raw):
    if ln.strip() == "subagent:" and (len(ln) - len(ln.lstrip())) == 0:
        start = i
        break
if start is None:
    sys.exit(0)
block = []
for ln in raw[start + 1:]:
    if not ln.strip():
        block.append(ln)
        continue
    if (len(ln) - len(ln.lstrip())) == 0:
        break
    block.append(ln)

def strip_scalar(s):
    s = s.strip()
    if len(s) >= 2 and s[0] in "\"'" and s[-1] == s[0]:
        s = s[1:-1]
    return s

# Find `<indent>key:` at the block's own base indent.
key_idx = None
key_indent = None
for i, ln in enumerate(block):
    if not ln.strip() or ln.lstrip().startswith("#"):
        continue
    indent = len(ln) - len(ln.lstrip())
    stripped = ln.strip()
    if stripped == f"{key}:" or stripped.startswith(f"{key}:"):
        key_idx = i
        key_indent = indent
        break
if key_idx is None:
    sys.exit(0)

rest = block[key_idx].strip()[len(key) + 1:].strip()
items = []
if rest.startswith("["):
    inner = rest[1:rest.rfind("]")] if "]" in rest else rest[1:]
    for part in inner.split(","):
        part = strip_scalar(part)
        if part:
            items.append(part)
elif rest.startswith("{"):
    sys.exit(0)  # flow map (e.g. tiers) — not consumed by the commit lane
elif rest:
    print(strip_scalar(rest))
    sys.exit(0)
else:
    # Block list: following lines more-indented than the key, each `- item`.
    for ln in block[key_idx + 1:]:
        if not ln.strip():
            continue
        indent = len(ln) - len(ln.lstrip())
        if indent <= key_indent:
            break
        s = ln.strip()
        if s.startswith("- "):
            items.append(strip_scalar(s[2:]))
        elif s == "-":
            items.append("")
for it in items:
    print(it)
PY
}

# resolve_subagent_input <token> <receipt-file>
#   Map a typed input token to the concrete handle phrase the sub-agent is handed.
#   `receipt`/`issue` derive from the receipt path; `layer-map` reads
#   GOVERNANCE_LAYER_DOC (the caller exports it from its conf). Unknown tokens
#   pass through verbatim so a directive can name a bespoke input.
resolve_subagent_input() {
    local token="$1" receipt="${2:-}"
    local n=""
    case "$receipt" in
        *issue-*) n="${receipt##*issue-}"; n="${n%%[-.]*}" ;;
    esac
    [[ "$n" =~ ^[0-9]+$ ]] || n="<N>"
    case "$token" in
        diff)       printf 'the diff (`git diff`)' ;;
        receipt)    printf 'this receipt (`%s`)' "$receipt" ;;
        issue)      printf 'the linked issue (`gh issue view #%s`)' "$n" ;;
        transcript)
            if [[ -n "${CODEX_TRANSCRIPT_PATH:-}" ]]; then
                printf 'the Codex session transcript at `%s`' "$CODEX_TRANSCRIPT_PATH"
            elif [[ -n "${CODEX_THREAD_ID:-}" ]]; then
                printf 'the Codex session transcript (the JSONL under `~/.codex/sessions/` or `~/.codex/archived_sessions/` whose filename ends with `$CODEX_THREAD_ID.jsonl`)'
            elif [[ -n "${CLAUDE_TRANSCRIPT_PATH:-}" ]]; then
                printf 'the Claude Code session transcript at `%s`' "$CLAUDE_TRANSCRIPT_PATH"
            elif [[ -n "${CLAUDE_CODE_SESSION_ID:-}" ]]; then
                printf 'the Claude Code session transcript (the JSONL named `$CLAUDE_CODE_SESSION_ID.jsonl` under your Claude Code projects dir)'
            else
                printf 'the active agent session transcript for this commit'
            fi
            ;;
        layer-map)  printf 'the declared layer model in `%s`' "${GOVERNANCE_LAYER_DOC:-ARCHITECTURE.md}" ;;
        *)          printf '%s' "$token" ;;
    esac
}

# _subagent_tier <directive.yaml> <attest|sweep>
#   Read `subagent.tiers.<which>` from the flow map declared in directive.yaml
#   (`tiers: { attest: low, sweep: high }`). _subagent_yaml deliberately skips
#   flow maps, so this is the dedicated reader for the one map the block carries.
#   Prints the tier token or nothing.
_subagent_tier() {
    python3 - "$1" "$2" <<'PY'
import re, sys
path, which = sys.argv[1], sys.argv[2]
try:
    raw = open(path, encoding="utf-8").read().splitlines()
except OSError:
    sys.exit(0)
in_block = False
for ln in raw:
    if ln.strip() == "subagent:" and (len(ln) - len(ln.lstrip())) == 0:
        in_block = True
        continue
    if in_block:
        if ln.strip() and (len(ln) - len(ln.lstrip())) == 0:
            break  # dedented out of the subagent block
        s = ln.strip()
        if s.startswith("tiers:"):
            m = re.search(rf"\b{re.escape(which)}\s*:\s*([A-Za-z0-9_-]+)", s)
            if m:
                print(m.group(1))
            sys.exit(0)
PY
}

# _subagent_tier_resolve <id> <defaults-file> <directive.yaml> <attest|sweep>
#   Operator-tunable capability tier (issue #331). Precedence, via conf_get:
#     env GOVERNANCE_SUBAGENT_TIERS_<WHICH> > user overlay row > defaults.conf row
#   then, when conf carries no value (e.g. a directive folder vendored from a
#   pre-#331 release that ships no defaults.conf), the directive.yaml
#   `subagent.tiers.<which>` value, then a hardcoded floor (attest→low, sweep→high).
#   Resolving through conf_get keeps the directive.yaml value as the effective
#   default — behavior is unchanged until a consumer writes an overlay row.
_subagent_tier_resolve() {
    local id="$1" defaults="$2" yaml="$3" which="$4" key tier
    case "$which" in
        attest) key="SUBAGENT_TIERS_ATTEST" ;;
        sweep)  key="SUBAGENT_TIERS_SWEEP" ;;
        *) return 1 ;;
    esac
    tier="$(conf_get "$id" "$key" "$defaults" 2>/dev/null)" || tier=""
    [[ -n "$tier" ]] || tier="$(_subagent_tier "$yaml" "$which")"
    if [[ -z "$tier" ]]; then
        case "$which" in attest) tier="low" ;; *) tier="high" ;; esac
    fi
    printf '%s\n' "$tier"
}

# _subagent_register <isolation> <tier> <receipt> <section> <inputs-US> <checks-US>
#   Append one pending-attestation record to the shared ledger, if the harness
#   set GOVERNANCE_ATTEST_LEDGER. No ledger → no-op (the per-section gate already
#   recorded its violation, so CI / a bare commit still fails correctly; the
#   grouped instruction is the orchestrated convenience layered on top). <tier>
#   is the conf-resolved attest tier (issue #331), threaded so the orchestrator
#   can name the requested tier in the grouped instruction.
_SUBAGENT_US=$'\x1f'
_subagent_register() {
    [[ -n "${GOVERNANCE_ATTEST_LEDGER:-}" ]] || return 0
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$5" "$6" >> "$GOVERNANCE_ATTEST_LEDGER"
}

# subagent_attest <receipt-file>
#   The migrated per-directive gate. Reads the sibling directive.yaml's
#   `subagent:` block, enforces the section is present + verdict-bearing (records
#   a violation otherwise — the deterministic gate, unchanged in spirit from
#   require_attestation), and registers any pending section for the orchestrator.
#   Returns 0 when the section is well-formed, 1 otherwise.
subagent_attest() {
    local file="$1"
    local dir; dir="$(dirname "$0")"
    local yaml="$dir/directive.yaml"
    if [[ ! -f "$yaml" ]]; then
        violation "$file — directive.yaml not found beside check.sh; cannot resolve the subagent declaration"
        return 1
    fi
    # Operator-tunable operational knobs (issue #331): isolation (batching) and
    # the attest capability tier resolve through the conf overlay, falling back
    # to the directive.yaml value so behavior is unchanged until a consumer
    # writes a row. The semantic fields (inputs, checks, section) stay read
    # straight from directive.yaml — they must not be tweakable without a fork.
    local id defaults; id="$(basename "$dir")"; defaults="$dir/defaults.conf"
    local section isolation tier
    section="$(_subagent_yaml "$yaml" section)"
    isolation="$(conf_get "$id" SUBAGENT_ISOLATION "$defaults" 2>/dev/null)" || isolation=""
    [[ -n "$isolation" ]] || isolation="$(_subagent_yaml "$yaml" isolation)"
    [[ -n "$isolation" ]] || isolation="shared"
    tier="$(_subagent_tier_resolve "$id" "$defaults" "$yaml" attest)"
    if [[ -z "$section" ]]; then
        violation "$file — directive.yaml declares no 'subagent.section'; cannot gate the attestation"
        return 1
    fi

    # Resolve the declared inputs to handle phrases and join with US separators.
    local inputs_joined="" tok phrase
    while IFS= read -r tok; do
        [[ -z "$tok" ]] && continue
        phrase="$(resolve_subagent_input "$tok" "$file")"
        if [[ -z "$inputs_joined" ]]; then inputs_joined="$phrase"
        else inputs_joined="$inputs_joined$_SUBAGENT_US$phrase"; fi
    done < <(_subagent_yaml "$yaml" inputs)

    # Join the declared checks with US separators.
    local checks_joined="" c
    while IFS= read -r c; do
        [[ -z "$c" ]] && continue
        if [[ -z "$checks_joined" ]]; then checks_joined="$c"
        else checks_joined="$checks_joined$_SUBAGENT_US$c"; fi
    done < <(_subagent_yaml "$yaml" checks)

    # The gate: section present + a PASS/REFUTED verdict. On a miss, record a
    # terse violation (the consolidated authoring instruction comes from the
    # orchestrator) and register the pending section.
    if ! grep -qE "^##[[:space:]]+${section}\b" "$file"; then
        violation "$file — missing a '## ${section}' section; a fresh-context sub-agent must record its verdict here (see the grouped sub-agent instruction below)."
        _subagent_register "$isolation" "$tier" "$file" "$section" "$inputs_joined" "$checks_joined"
        return 1
    fi
    local body; body="$(extract_md_section "$file" "$section")"
    if ! printf '%s\n' "$body" | grep -qiE '\b(PASS|REFUTED)\b'; then
        violation "$file — '## ${section}' records no PASS/REFUTED verdict; the sub-agent must report a verdict + evidence for each named check (see the grouped sub-agent instruction below)."
        _subagent_register "$isolation" "$tier" "$file" "$section" "$inputs_joined" "$checks_joined"
        return 1
    fi
    return 0
}

# attestation_remediation [<ledger-file>]
#   The shared orchestrator. Run once (by run.sh / the pre-commit dispatcher)
#   after every check.sh. Reads the pending-attestation ledger and emits ONE
#   grouped remediation instruction to stderr: a single sub-agent for all
#   `isolation: shared` sections (handed the union of their inputs), plus one
#   isolated sub-agent per `isolation: isolated` section. No pending records →
#   silent no-op. The hook never spawns the sub-agent itself — the harness agent
#   reads this instruction and spawns it.
attestation_remediation() {
    local ledger="${1:-${GOVERNANCE_ATTEST_LEDGER:-}}"
    [[ -n "$ledger" && -s "$ledger" ]] || return 0
    # The ledger is TSV — `isolation \t tier \t receipt \t section \t inputs \t checks` —
    # whose inputs/checks fields are US-joined (\x1f). The `tier` column is the
    # conf-resolved attest capability tier (issue #331). A 5-column row (no tier)
    # from an older writer degrades to the low tier. Formatting the grouped
    # instruction is pure text munging over strings full of backticks and quotes;
    # stdlib python does it without the quoting hazards of bash, and python3 is
    # already present whenever an attestation registered (those directives run it).
    python3 - "$ledger" >&2 <<'PY'
import sys

US = "\x1f"
_RANK = {"low": 0, "medium": 1, "high": 2}

def tier_phrase(tier):
    # Mirrors lib.sh `_tier_phrase`; the attest lane runs cheap by default and a
    # consumer raises it via SUBAGENT_TIERS_ATTEST (issue #331).
    if tier == "high":
        return ("a capable model (the high capability tier, e.g. Claude Opus or "
                "Sonnet, or a comparable frontier model)")
    if tier == "medium":
        return "a mid-capability model (the medium capability tier)"
    return ("a small, low-cost model (the low capability tier; for Codex use "
            "a mini-class model, for Claude Code use a Haiku-class model — this is a bounded "
            "read-and-record audit whose verdict the merge-time sweep lane "
            "independently re-derives)")

shared, isolated = [], []
try:
    rows = open(sys.argv[1], encoding="utf-8").read().splitlines()
except OSError:
    sys.exit(0)
for line in rows:
    if not line.strip():
        continue
    parts = line.split("\t")
    if len(parts) >= 6:
        iso, tier, receipt, section, inputs, checks = parts[:6]
    elif len(parts) == 5:
        iso, receipt, section, inputs, checks = parts
        tier = "low"
    else:
        continue
    rec = {
        "receipt": receipt,
        "section": section,
        "tier": tier if tier in _RANK else "low",
        "inputs": [p for p in inputs.split(US) if p],
        "checks": [c for c in checks.split(US) if c],
    }
    (isolated if iso == "isolated" else shared).append(rec)

if not shared and not isolated:
    sys.exit(0)

def numbered(checks):
    return "; ".join(f"({i}) {c}" for i, c in enumerate(checks, 1))

out = []
out.append("")
out.append("─" * 40)
out.append("⚖ Sub-agent attestation(s) pending — populate each section below, then re-stage and re-commit.")

if shared:
    union, seen = [], set()
    for r in shared:
        for ip in r["inputs"]:
            if ip not in seen:
                seen.add(ip)
                union.append(ip)
    # Batched sections may declare different attest tiers; run the shared spawn
    # at the most capable one requested so no directive is under-resourced.
    group_tier = max((r["tier"] for r in shared), key=lambda t: _RANK.get(t, 0))
    out.append("")
    out.append(
        "Spawn ONE fresh-context sub-agent on " + tier_phrase(group_tier)
        + ". Hand it exactly these inputs: "
        + ", ".join(union)
        + ". Render a verdict + evidence for every check below, rendering each "
        "verdict as exactly the token PASS or REFUTED; default to REFUTED if "
        "uncertain. Write each group's findings into the named section of the "
        "named receipt:"
    )
    for r in shared:
        out.append(f"  • In `{r['receipt']}`, write the '## {r['section']}' section: {numbered(r['checks'])}")

for r in isolated:
    out.append("")
    out.append(
        "Spawn a separate fresh-context sub-agent (isolated — no shared context) on "
        + tier_phrase(r["tier"]) + ". Hand it exactly these inputs: "
        + ", ".join(r["inputs"])
        + f". Render a verdict + evidence for each, as exactly PASS or REFUTED "
        f"(default REFUTED if uncertain), into the '## {r['section']}' section of "
        f"`{r['receipt']}`: {numbered(r['checks'])}"
    )

out.append("")
out.append("The hook never spawns the sub-agent itself; do not self-author these sections in the primary agent context.")
out.append("─" * 40)
print("\n".join(out))
PY
}

# ── Per-directive configuration ────────────────────────────────────────────
# Configuration is exactly two artifacts, one writer each (issue #210):
#   * the pack-owned `defaults.conf` next to the directive's `check.sh` — the
#     live defaults *and* their documentation, refreshed by `pack update`; and
#   * the user overlay `.governance/conf/<owner>/<pack>/<id>.conf` — seeded once
#     at install from a single generic kit stub and never rewritten by any
#     lifecycle verb. The path is pack-qualified so two packs shipping a
#     same-named directive (homonyms) get independent overlays.
# Both files share one line-based format: `KEY=value` lines (KEY is `[A-Z_]+`)
# are scalar settings; every other non-comment, non-blank line is a
# directive-defined rule line. Blank lines and `#` comments are ignored. The
# overlay additionally honors `!<rule>` to drop a default (see `conf_list`).
#
# These helpers resolve the repo root themselves, so they work identically in
# a commit-msg hook (Mode A) and under run.sh / CI (Mode B).

# _conf_pack_qualifier
# Derive the installed pack qualifier `<owner>/<pack>` from the running
# check.sh path (`.governance/packs/<owner>/<pack>/directives/<id>/check.sh`,
# which is `$0` whether the check is invoked by run.sh or a generated hook).
# Prints `<owner>/<pack>` or nothing when `$0` isn't an installed check.sh
# (e.g. a unit test that sources lib.sh and calls a conf helper directly).
_conf_pack_qualifier() {
    # Match an absolute (/abs/.governance/packs/…) or relative
    # (.governance/packs/…) check.sh path — run.sh passes absolute, the eval
    # harness and some hooks pass relative.
    local src="${0:-}" after owner pack
    case "$src" in
        *.governance/packs/*/directives/*)
            after="${src##*.governance/packs/}"   # <owner>/<pack>/directives/<id>/...
            owner="${after%%/*}"; after="${after#*/}"
            pack="${after%%/*}"
            [[ -n "$owner" && -n "$pack" ]] && printf '%s/%s' "$owner" "$pack"
            ;;
    esac
}

# conf_file <directive-id>
# Print the path to the directive's user conf and return 0 if it exists;
# return 1 (printing nothing) otherwise. Conf-driven directives typically
# treat a missing conf as "nothing opted in" and no-op. When the caller is an
# installed check.sh the path is pack-qualified
# (`.governance/conf/<owner>/<pack>/<id>.conf`); otherwise it falls back to the
# bare `.governance/conf/<id>.conf` for direct-invocation contexts.
conf_file() {
    local id="$1" root pack_q
    root="$(git rev-parse --show-toplevel 2>/dev/null)" || return 1
    pack_q="$(_conf_pack_qualifier)"
    local f
    if [[ -n "$pack_q" ]]; then
        f="$root/.governance/conf/$pack_q/$id.conf"
    else
        f="$root/.governance/conf/$id.conf"
    fi
    [[ -f "$f" ]] || return 1
    printf '%s\n' "$f"
}

# conf_get <directive-id> <KEY> <defaults-file>
# Resolve a scalar setting. Precedence:
#   1. environment `GOVERNANCE_<KEY>`            (when set and non-empty)
#   2. first `^KEY=` line in the user overlay    (.governance/conf/.../<id>.conf)
#   3. first `^KEY=` line in the pack-owned <defaults-file> (its `defaults.conf`)
# The pack-owned `defaults.conf` is the single source of a knob's default *and*
# its documentation (issue #210); there is no in-code default constant. So a
# <defaults-file> that names a `defaults.conf` but is missing, or that carries
# no `KEY=` row, is a broken install — conf_get writes an error to stderr and
# returns non-zero (fails loud) rather than running the directive on a phantom
# value. Call sites pass `"$(dirname "$0")/defaults.conf"`, the same plumbing
# `conf_list` already uses.
#
# Transitional compatibility: a <defaults-file> that is a bare literal (not a
# path ending in `defaults.conf`) is treated as an in-code default value — the
# pre-#210 calling convention. This keeps a directive folder vendored from a
# pre-#210 release (its check.sh still passes literal defaults) working against
# this newer lib.sh during the one-release dogfood lag. New directives must pass
# a `defaults.conf` path; remove this branch once no released directive passes a
# literal.
conf_get() {
    local id="$1" key="$2" defaults="${3:-}"
    local env_name="GOVERNANCE_${key}"
    if [[ -n "${!env_name:-}" ]]; then
        printf '%s\n' "${!env_name}"
        return 0
    fi
    local f line
    if f="$(conf_file "$id")"; then
        line="$(grep -E "^${key}=" "$f" 2>/dev/null | head -n 1)"
        if [[ -n "$line" ]]; then
            printf '%s\n' "${line#*=}"
            return 0
        fi
    fi
    case "$defaults" in
        */defaults.conf | defaults.conf)
            if [[ ! -f "$defaults" ]]; then
                printf 'governance: conf_get %s: defaults file %s not found (broken install)\n' \
                    "$key" "$defaults" >&2
                return 1
            fi
            line="$(grep -E "^${key}=" "$defaults" 2>/dev/null | head -n 1)"
            if [[ -z "$line" ]]; then
                printf 'governance: conf_get %s: no %s= row in %s (broken pack)\n' \
                    "$key" "$key" "$defaults" >&2
                return 1
            fi
            printf '%s\n' "${line#*=}"
            return 0
            ;;
        *)
            # Pre-#210 literal-default convention (transitional — see header).
            printf '%s\n' "$defaults"
            return 0
            ;;
    esac
}

# conf_rule_lines <directive-id>
# Emit the directive-defined rule lines from the conf: trimmed, with `#`
# comments and blank lines stripped, and `KEY=value` scalar lines skipped.
# Emits nothing (returns 0) when no conf exists.
conf_rule_lines() {
    local f raw entry
    f="$(conf_file "$1")" || return 0
    while IFS= read -r raw || [[ -n "$raw" ]]; do
        entry="${raw%%#*}"
        entry="${entry#"${entry%%[![:space:]]*}"}"
        entry="${entry%"${entry##*[![:space:]]}"}"
        [[ -z "$entry" ]] && continue
        [[ "$entry" =~ ^[A-Z_]+= ]] && continue
        printf '%s\n' "$entry"
    done < "$f"
}

# conf_list <directive-id> <defaults-file>
# Emit the effective list for a directive whose default items ship in
# <defaults-file> (a pack-owned `defaults.conf`, one item per line), with the
# user overlay (`.governance/conf/<id>.conf`) layered on top:
#   bare line   → adds an item
#   !item       → removes the matching default item (gitignore-style negation)
#   KEY=value   → ignored here (read scalars with conf_get)
# Default items keep their order; additions follow. A `!` that matches no
# default is a harmless no-op. Comments and blank lines are stripped from both.
_conf_trim() {  # echo the argument with surrounding whitespace removed
    local s="$1"
    s="${s#"${s%%[![:space:]]*}"}"
    s="${s%"${s##*[![:space:]]}"}"
    printf '%s' "$s"
}
_conf_norm() {  # trim + collapse internal whitespace runs to one space
    local parts
    # shellcheck disable=SC2206
    read -ra parts <<< "$1"
    printf '%s' "${parts[*]}"
}
conf_list() {
    local id="$1" defaults="$2" overlay line item key
    local removed=$'\n' emitted=$'\n'
    local adds=()

    # Membership tests compare whitespace-normalized keys so a `!frozen-section
    # QUALITY.md Resolved` overlay line matches a column-aligned default.
    if overlay="$(conf_file "$id")"; then
        while IFS= read -r line || [[ -n "$line" ]]; do
            line="$(_conf_trim "${line%%#*}")"
            [[ -z "$line" ]] && continue
            [[ "$line" =~ ^[A-Z_]+= ]] && continue
            if [[ "${line:0:1}" == '!' ]]; then
                item="$(_conf_norm "${line:1}")"
                [[ -n "$item" ]] && removed+="$item"$'\n'
            else
                # An explicit leading '+' is an optional "add" marker; strip it.
                [[ "${line:0:1}" == '+' ]] && line="$(_conf_trim "${line:1}")"
                [[ -n "$line" ]] && adds+=("$line")
            fi
        done < "$overlay"
    fi

    # Defaults in declared order, minus anything the overlay removed.
    if [[ -f "$defaults" ]]; then
        while IFS= read -r line || [[ -n "$line" ]]; do
            line="$(_conf_trim "${line%%#*}")"
            [[ -z "$line" ]] && continue
            [[ "$line" =~ ^[A-Z_]+= ]] && continue
            key="$(_conf_norm "$line")"
            case "$removed" in *$'\n'"$key"$'\n'*) continue ;; esac
            case "$emitted" in *$'\n'"$key"$'\n'*) continue ;; esac
            emitted+="$key"$'\n'
            printf '%s\n' "$line"
        done < "$defaults"
    fi

    # Overlay additions (skipping ones already emitted or explicitly removed).
    # `${adds[@]+...}` keeps an empty array safe under `set -u` on bash 3.2.
    for line in ${adds[@]+"${adds[@]}"}; do
        key="$(_conf_norm "$line")"
        case "$removed" in *$'\n'"$key"$'\n'*) continue ;; esac
        case "$emitted" in *$'\n'"$key"$'\n'*) continue ;; esac
        emitted+="$key"$'\n'
        printf '%s\n' "$line"
    done
}
