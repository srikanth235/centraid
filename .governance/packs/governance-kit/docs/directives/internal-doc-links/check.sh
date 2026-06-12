#!/usr/bin/env bash
# Directive: internal-doc-links — the internal markdown link graph is healthy.
# Rolls up two sub-checks over the same `[text](target)` graph across tracked
# `.md` files:
#   resolve   — every relative-path link target points at a file that exists
#               (the "no dead links" half). Always on.
#   reachable — every tracked doc is reachable by following internal links from
#               an entry-point ("root") doc declared in
#               `.governance/conf/governance-kit/docs/internal-doc-links.conf`. The "no orphan docs"
#               half. NO-OP unless that config file exists and names ≥1 root.
#
# Why one directive: `resolve` proves the links you have point somewhere real;
# `reachable` proves the docs you wrote are on the map. Both parse the same
# internal link graph, so they share extraction and path-normalization here
# rather than in two directives. `resolve` is the always-on minimum (a dead
# link is rot an agent bails on); `reachable` is opt-in because "every doc must
# be linked" is a real policy only some repos want — without the config it does
# nothing.
#
# To carve out a sub-check for your repo, use `governance directive modify` to
# amend this script (or `governance directive remove` to drop the directive).
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "internal-doc-links"
require_git

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT" || exit 1

# parse_target <raw-link>  →  echoes the bare target (no anchor, no title) or
# empty for external / in-page / empty targets. Shared by both sub-checks.
parse_target() {
    local match="$1" target
    target="${match##*(}"   # strip leading "[text]("
    target="${target%)}"    # strip trailing ")"
    target="${target%% *}"  # drop optional `"Title"`
    case "$target" in
        http://*|https://*|mailto:*|tel:*|'#'*|'<'*|'') printf '' ; return 0 ;;
    esac
    target="${target%%#*}"  # drop anchor fragment
    printf '%s' "$target"
}

# normalize_path — resolve . and .. segments in a repo-relative path.
normalize_path() {
    local p="$1" seg oldIFS="$IFS"
    local -a parts=()
    IFS='/'
    for seg in $p; do
        case "$seg" in
            ''|.) ;;
            ..) [[ ${#parts[@]} -gt 0 ]] && parts=("${parts[@]:0:${#parts[@]}-1}") ;;
            *)  parts+=("$seg") ;;
        esac
    done
    local joined="${parts[*]}"
    IFS="$oldIFS"
    printf '%s' "$joined"
}

# A file whose own contents look like links but aren't doc links: directive
# folders carry regex strings, skill asset templates carry links that resolve
# relative to the TARGET repo they're injected into, not to the asset's path.
is_link_noise_file() {
    case "$1" in
        */directives/*) return 0 ;;
        */assets/*.md)  return 0 ;;
    esac
    return 1
}

# ── sub-check: resolve ────────────────────────────────────────
# Every relative-path link target in a tracked .md file resolves to a real
# file. Checks targets of every kind (other docs, images, scripts, dirs) — not
# just .md — so a `[script](setup.sh)` that 404s is caught too.
link_re_extract='\[[^]]*\]\([^)]+\)'
while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    is_link_noise_file "$file" && continue
    # Skip immutable append-only ledgers (receipts, plans, COSTS.md). They are
    # records of a past repo state — doc-integrity forbids editing them, so a
    # link that rots when a file later moves can never be repaired. Gating on
    # their links would be an unfixable failure, so they are out of scope.
    case "$file" in receipts/*|plans/*|COSTS.md) continue ;; esac
    while IFS=: read -r line_no match; do
        [[ -z "$line_no" || -z "$match" ]] && continue
        target="$(parse_target "$match")"
        [[ -z "$target" ]] && continue
        local_dir=$(dirname "$file")
        if [[ "$target" == /* ]]; then
            resolved="${ROOT}${target}"
        else
            resolved="${ROOT}/${local_dir}/${target}"
        fi
        [[ -e "$resolved" ]] && continue
        has_waiver "$file" "$line_no" "internal-doc-links" && continue
        violation "$file:$line_no — broken link to '$target'"
    done < <(grep -noE "$link_re_extract" "$file" 2>/dev/null || true)
done < <(git ls-files -- '*.md' '*.markdown' ':!vendor/**' ':!node_modules/**' 2>/dev/null || true)

# ── sub-check: reachable ──────────────────────────────────────
# No-op unless .governance/conf/governance-kit/docs/internal-doc-links.conf exists and names ≥1 root.
if CONF="$(conf_file internal-doc-links)"; then
    roots=()
    conf_excludes=()
    while IFS= read -r line || [[ -n "$line" ]]; do
        line="${line%%#*}"                       # strip trailing comment
        line="${line#"${line%%[![:space:]]*}"}"  # ltrim
        line="${line%"${line##*[![:space:]]}"}"  # rtrim
        [[ -z "$line" ]] && continue
        key="${line%% *}"
        val="${line#* }"
        [[ "$val" == "$line" ]] && val=""
        case "$key" in
            root)    [[ -n "$val" ]] && roots+=("$val") ;;
            exclude) [[ -n "$val" ]] && conf_excludes+=("$val") ;;
        esac
    done < "$CONF"

    if [[ ${#roots[@]} -gt 0 ]]; then
        # Tracked-markdown set as a newline-delimited string (bash 3.2 — no -A).
        TRACKED_MD=$'\n'
        while IFS= read -r f; do
            [[ -z "$f" ]] && continue
            TRACKED_MD+="$f"$'\n'
        done < <(git ls-files -- '*.md' '*.markdown' 2>/dev/null || true)

        is_tracked_md() {
            case "$TRACKED_MD" in *$'\n'"$1"$'\n'*) return 0 ;; *) return 1 ;; esac
        }

        # md_links_in <file> — emit each internal .md link target, normalized
        # to a repo-relative path, one per line.
        md_links_in() {
            local file="$1" mdir t match
            mdir="$(dirname "$file")"
            while IFS= read -r match; do
                t="$(parse_target "$match")"
                [[ -z "$t" ]] && continue
                case "$t" in *.md|*.markdown) ;; *) continue ;; esac
                if [[ "$t" == /* ]]; then
                    printf '%s\n' "$(normalize_path "${t#/}")"
                else
                    printf '%s\n' "$(normalize_path "$mdir/$t")"
                fi
            done < <(grep -oE "$link_re_extract" "$file" 2>/dev/null || true)
        }

        VISITED=$'\n'
        QUEUE=()
        for r in "${roots[@]}"; do
            r="$(normalize_path "$r")"
            is_tracked_md "$r" || continue
            case "$VISITED" in
                *$'\n'"$r"$'\n'*) ;;
                *) VISITED+="$r"$'\n'; QUEUE+=("$r") ;;
            esac
        done

        if [[ ${#QUEUE[@]} -eq 0 ]]; then
            violation "reachable — none of the configured roots [${roots[*]}] are tracked .md files (check .governance/conf/governance-kit/docs/internal-doc-links.conf)"
        else
            while [[ ${#QUEUE[@]} -gt 0 ]]; do
                cur="${QUEUE[0]}"
                QUEUE=("${QUEUE[@]:1}")
                while IFS= read -r tgt; do
                    [[ -z "$tgt" ]] && continue
                    is_tracked_md "$tgt" || continue
                    case "$VISITED" in
                        *$'\n'"$tgt"$'\n'*) ;;
                        *) VISITED+="$tgt"$'\n'; QUEUE+=("$tgt") ;;
                    esac
                done < <(md_links_in "$cur")
            done

            is_reach_noise() {
                case "$1" in
                    */directives/*|*/evals/*|*/assets/*) return 0 ;;
                    node_modules/*|*/node_modules/*|vendor/*|*/vendor/*) return 0 ;;
                esac
                return 1
            }
            is_conf_excluded() {
                [[ ${#conf_excludes[@]} -eq 0 ]] && return 1
                local g
                for g in "${conf_excludes[@]}"; do
                    [[ "$1" == $g ]] && return 0
                done
                return 1
            }

            while IFS= read -r f; do
                [[ -z "$f" ]] && continue
                is_reach_noise "$f" && continue
                is_conf_excluded "$f" && continue
                case "$VISITED" in *$'\n'"$f"$'\n'*) continue ;; esac
                if head -n 10 "$f" 2>/dev/null | grep -q "governance: allow-internal-doc-links reachable"; then
                    continue
                fi
                violation "reachable — $f is an orphaned doc, unreachable from any configured root (link it from a doc in the graph, add an 'exclude' line to .governance/conf/governance-kit/docs/internal-doc-links.conf, or add a 'governance: allow-internal-doc-links reachable <reason>' comment in its first 10 lines)"
            done < <(git ls-files -- '*.md' '*.markdown' 2>/dev/null || true)
        fi
    fi
fi

directive_end
