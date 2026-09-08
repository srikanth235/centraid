#!/usr/bin/env bash
# Directive: managed-tree-integrity (issue #253) — the `.governance/` managed
# tree matches the content digests recorded at apply time, so it can only
# change through the install/update verbs, never by hand. For every pack entry
# in `.governance/packs.lock` that carries a `digest:` map, each vendored
# directive folder must match its recorded digest (and no unrecorded directive
# folder may appear); for every file in `.governance/install.yaml`'s
# `managed_digests:` map, the kit-runtime file must match its recorded digest.
#
# Works OFFLINE in any consumer repo — it compares against digests recorded in
# the lock/manifest, not against upstream pack git objects, so unlike the
# dogfood-only `consumed-tree-integrity` it ships to everyone.
#
# Back-compat: a pack with no `digest:` (or a manifest with no
# `managed_digests:`) is skipped — pre-#253 installs gain coverage on their
# next `pack update` / `kit update`.
#
# Pure bash/awk (issue #355 — the commit path is zero-python): digest recompute
# lives in `lib/digest.sh` (byte-identical algorithm to
# `kit/assets/packs/lib/digestlib.py`, pinned by `scripts/test-digestlib.py`);
# packs.lock / install.yaml are hand-parsed below with POSIX awk. One violation
# per unit; per-unit waivers come from the tunable manifest config overlay.
set -u
source "$(dirname "$0")/../../../../../lib.sh"
source "$(dirname "$0")/lib/digest.sh"
directive_start "managed-tree-integrity"
require_git
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT" || exit 1
HERE="$(cd "$(dirname "$0")" && pwd)"

# Legacy seed-once sweep-lane assets (issue #259): exempt from the
# marker-vs-manifest check below (issue #263) — see the header note in
# lib/digest.sh's sibling comment and constitution.md for the rationale.
# Consumers who haven't run `governance update` past the sweep→schedule
# retirement still carry these exact paths. The digest check still guards
# their content fully.
SWEEP_ASSET_RELPATHS=".github/workflows/governance-sweep.yml .governance/sweep.sh"

# Generated schedule workflow (sweep-lane successor) is stamped at
# verb-run time (`governance workflow generate`), not at kit-release time, so
# its marker legitimately tracks the kit version current when it was
# generated rather than the manifest's pin — the same seed-time rationale as
# the legacy sweep pair above (issue #263). Marked legacy prefixed workflows
# remain covered during migration; unmarked hand-authored files are outside
# the generated namespace.
_mti_is_schedule_workflow() {
    case "$1" in
        .github/workflows/governance-schedule.yml) return 0 ;;
        .github/workflows/governance-schedule-*.yml)
            [[ -n "$(_mti_marker_version "$1")" ]] && return 0
            ;;
        *) return 1 ;;
    esac
}

# Waived units (pack/directive ids or runtime relpaths) from the conf overlay,
# layered on the (empty) pack default. The `${waived[@]+...}` expansion keeps
# an empty array safe under set -u on bash 3.2.
waived=()
while IFS= read -r u; do
    [[ -n "$u" ]] && waived+=("$u")
done < <(conf_list managed-tree-integrity "$HERE/directive.yaml" WAIVED_UNITS)

_mti_is_waived() {
    local u="$1" w
    for w in ${waived[@]+"${waived[@]}"}; do
        [[ "$w" == "$u" ]] && return 0
    done
    return 1
}

_mti_report() {  # _mti_report <unit> <message>
    _mti_is_waived "$1" || violation "$2"
}

# manifest_scalar <file> <key> — the value of a top-level `key: value` scalar
# line, mirroring the stdlib regex `^key:[ \t]*['"]?([^'"#\s]*)['"]?` (strip an
# optional leading quote, then take chars up to the next quote/#/whitespace).
_mti_manifest_scalar() {
    LC_ALL=C awk -v key="$2" '
        index($0, key ":") == 1 {
            line = $0
            sub("^" key ":[ \t]*", "", line)
            if (substr(line, 1, 1) == "\"" || substr(line, 1, 1) == "\x27") {
                line = substr(line, 2)
            }
            out = ""
            n = length(line)
            for (i = 1; i <= n; i++) {
                c = substr(line, i, 1)
                if (c == "\"" || c == "\x27" || c == "#" || c == " " || c == "\t") break
                out = out c
            }
            print out
            exit
        }
    ' "$1"
}

# marker_version <file> — the `governance-kit:managed kit-version=<v>` value
# stamped in the file's first 3 lines, or "" if unmarked.
_mti_marker_version() {
    [[ -f "$1" ]] || { printf ''; return 0; }
    LC_ALL=C head -n 3 "$1" | LC_ALL=C grep -m1 -oE 'governance-kit:managed.*kit-version=[^[:space:]]+' \
        | LC_ALL=C sed -E 's/.*kit-version=//'
}

# ── (a) vendored pack directive folders ─────────────────────────────────────
LOCK="$ROOT/.governance/packs.lock"
PACKS_DIR="$ROOT/.governance/packs"

if [[ -f "$LOCK" ]]; then
    lock_parsed="$(LC_ALL=C awk '
        BEGIN { pid = ""; mode = "" }
        /^- id:/ {
            pid = $0
            sub(/^- id:[ \t]*/, "", pid)
            gsub(/^[ \t]+|[ \t]+$/, "", pid)
            print "PACK\t" pid
            mode = ""
            next
        }
        pid == "" { next }
        /^  directives:/ { mode = "directives"; next }
        /^  digest:/ {
            rest = $0
            sub(/^  digest:[ \t]*/, "", rest)
            gsub(/^[ \t]+|[ \t]+$/, "", rest)
            print "META\t" pid
            if (rest == "{}") { mode = "" } else { mode = "digest" }
            next
        }
        /^  - / && mode == "directives" {
            item = $0
            sub(/^  - /, "", item)
            gsub(/^[ \t]+|[ \t]+$/, "", item)
            print "DIR\t" pid "\t" item
            next
        }
        /^    / && mode == "digest" {
            line = $0
            gsub(/^[ \t]+|[ \t]+$/, "", line)
            cp = index(line, ":")
            if (cp > 0) {
                k = substr(line, 1, cp - 1)
                v = substr(line, cp + 1)
                gsub(/^[ \t]+|[ \t]+$/, "", k)
                gsub(/^[ \t]+|[ \t]+$/, "", v)
                if (k != "") print "DIGEST\t" pid "\t" k "\t" v
            }
            next
        }
        /^  / && !/^    / && !/^  - / {
            mode = ""
            next
        }
    ' "$LOCK")"

    pack_ids="$(printf '%s\n' "$lock_parsed" | awk -F'\t' '$1 == "PACK" { print $2 }')"

    while IFS= read -r pid; do
        [[ -z "$pid" ]] && continue

        has_digest="$(printf '%s\n' "$lock_parsed" | awk -F'\t' -v p="$pid" '$1 == "META" && $2 == p { f = 1 } END { print f + 0 }')"
        [[ "$has_digest" == "1" ]] || continue

        dir_list_file="$(mktemp)"
        digest_keys_file="$(mktemp)"
        printf '%s\n' "$lock_parsed" | awk -F'\t' -v p="$pid" '$1 == "DIR" && $2 == p { print $3 }' > "$dir_list_file"
        printf '%s\n' "$lock_parsed" | awk -F'\t' -v p="$pid" '$1 == "DIGEST" && $2 == p { print $3 }' > "$digest_keys_file"

        while IFS=$'\t' read -r rectype recpid did want; do
            [[ "$rectype" == "DIGEST" && "$recpid" == "$pid" ]] || continue
            unit="$pid/$did"
            folder="$PACKS_DIR/$pid/directives/$did"
            if [[ ! -d "$folder" ]]; then
                _mti_report "$unit" "$unit: managed directive folder is missing — restore via 'governance pack update'"
                continue
            fi
            got="$(mti_dir_digest "$folder")"
            if [[ "$got" != "$want" ]]; then
                _mti_report "$unit" "$unit: content drifted from the digest recorded at apply time — hand-edited or stale; re-run 'governance pack update' (do not hand-edit .governance/)"
            fi
        done <<< "$lock_parsed"

        # orphan directive folder: present on disk but not recorded
        disk_dir="$PACKS_DIR/$pid/directives"
        if [[ -d "$disk_dir" ]]; then
            for child in "$disk_dir"/*; do
                [[ -d "$child" ]] || continue
                cname="$(basename "$child")"
                if ! LC_ALL=C grep -Fxq "$cname" "$digest_keys_file" && ! LC_ALL=C grep -Fxq "$cname" "$dir_list_file"; then
                    unit="$pid/$cname"
                    _mti_report "$unit" "$unit: directive folder is not recorded in packs.lock — installed by hand; add it via 'governance pack add/update' or remove it"
                fi
            done
        fi

        rm -f "$dir_list_file" "$digest_keys_file"
    done <<< "$pack_ids"
fi

# ── (b) kit-runtime managed files ───────────────────────────────────────────
MANIFEST="$ROOT/.governance/install.yaml"

if [[ -f "$MANIFEST" ]]; then
    manifest_parsed="$(LC_ALL=C awk '
        BEGIN { in_block = 0 }
        /^managed_digests:/ {
            rest = $0
            sub(/^managed_digests:[ \t]*/, "", rest)
            gsub(/^[ \t]+|[ \t]+$/, "", rest)
            print "MDPRESENT"
            if (rest == "{}") { in_block = 0 } else { in_block = 1 }
            next
        }
        in_block == 1 {
            if ($0 ~ /^  /) {
                stripped = $0
                gsub(/^[ \t]+|[ \t]+$/, "", stripped)
                if (stripped ~ /^#/) next
                cp = index(stripped, ":")
                if (cp > 0) {
                    k = substr(stripped, 1, cp - 1)
                    v = substr(stripped, cp + 1)
                    gsub(/^[ \t]+|[ \t]+$/, "", k)
                    gsub(/^[ \t]+|[ \t]+$/, "", v)
                    if (k != "") print "MD\t" k "\t" v
                }
                next
            }
            if ($0 != "" && $0 !~ /^[ \t]/) { in_block = 0 }
        }
    ' "$MANIFEST")"

    md_present="$(printf '%s\n' "$manifest_parsed" | awk -F'\t' '$1 == "MDPRESENT" { f = 1 } END { print f + 0 }')"

    if [[ "$md_present" == "1" ]]; then
        kit_version="$(_mti_manifest_scalar "$MANIFEST" "kit_version")"

        while IFS=$'\t' read -r rectype rel want; do
            [[ "$rectype" == "MD" ]] || continue
            f="$ROOT/$rel"
            if [[ ! -f "$f" ]]; then
                _mti_report "$rel" "$rel: managed kit-runtime file is missing — restore via 'governance update'"
                continue
            fi
            got="$(mti_sha256_file "$f")"
            if [[ "$got" != "$want" ]]; then
                _mti_report "$rel" "$rel: kit-runtime file drifted from the digest recorded at apply time — hand-edited or stale; re-run 'governance update' (do not hand-edit .governance/)"
                continue
            fi
            # Marker / manifest consistency (subsumes the former
            # kit-version-sync): a hand-edited manifest kit_version leaves the
            # files matching their recorded digests, so the digest alone can't
            # catch it — compare the file's stamped marker to the manifest's
            # kit_version. Legacy seed-once sweep assets and generated
            # schedule-lane workflows are exempt (issue #263).
            case " $SWEEP_ASSET_RELPATHS " in
                *" $rel "*) continue ;;
            esac
            _mti_is_schedule_workflow "$rel" && continue
            mv="$(_mti_marker_version "$f")"
            if [[ -n "$kit_version" && -n "$mv" && "$mv" != "$kit_version" ]]; then
                _mti_report "$rel" "$rel: stamped kit-version=$mv but install.yaml pins kit_version=$kit_version — half-applied update or an out-of-band version edit; re-run 'governance update'"
            fi
        done <<< "$manifest_parsed"
    fi
fi

directive_end
