#!/usr/bin/env bash
# lib/digest.sh — pure bash/awk digest routines for managed-tree-integrity
# (issue #355). Replaces the former lib/integrity.py: the commit path must
# contain zero python invocations, so the digest recompute now runs entirely
# in bash + POSIX awk + shasum/sha256sum.
#
# The algorithm here MUST stay byte-identical to
# `kit/assets/packs/lib/digestlib.py` (the apply engines' Python copy that
# records digests at materialization time). `scripts/test-digestlib.py` pins
# the two together.
#
#   file digest      = sha256 hex of the file's raw bytes.
#   directory digest  = sha256 over the concatenated stream, for each KEPT
#                       file sorted by posix relpath:
#                         <relpath-utf8> + NUL + <file-sha256-hex-ascii> + '\n'
#                       KEPT = every file under the dir, excluding any path
#                       with a component (including the filename itself) equal
#                       to "evals", "install-assets", or "__pycache__", and
#                       excluding any file whose name ends in ".pyc".
#   An empty or missing directory digests to the empty string (not the sha256
#   of zero bytes).
#
# bash 3.2 / POSIX awk only: no associative arrays, no `mapfile`, no gawk-isms.
# Sorting and text matching are byte-wise (`LC_ALL=C`) to match Python's
# default `sorted()` over the (ASCII) relpaths this repo produces.

set -u

# _mti_sha256_stream — sha256 hex of raw stdin bytes.
_mti_sha256_stream() {
    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 | awk '{print $1}'
    elif command -v sha256sum >/dev/null 2>&1; then
        sha256sum | awk '{print $1}'
    else
        printf 'mti_sha256: no sha256 utility found (need shasum or sha256sum)\n' >&2
        return 1
    fi
}

# mti_sha256_file <path> — sha256 hex of a single file's raw bytes.
mti_sha256_file() {
    local path="$1"
    [[ -f "$path" ]] || { printf 'mti_sha256_file: not a file: %s\n' "$path" >&2; return 1; }
    _mti_sha256_stream < "$path"
}

# mti_dir_digest <dir> — sha256 over the sorted (relpath, file-digest) stream
# for every kept file under <dir>. Prints the empty string (no newline) for a
# missing or empty directory.
mti_dir_digest() {
    local dir="$1"
    [[ -d "$dir" ]] || { printf ''; return 0; }

    local relpaths kept sorted
    relpaths="$(cd "$dir" && find . -type f | LC_ALL=C sed 's|^\./||')"
    [[ -z "$relpaths" ]] && { printf ''; return 0; }

    # Exclusion: any "/"-separated component (including the filename) equal to
    # evals / install-assets / __pycache__, or a filename ending in ".pyc".
    kept="$(printf '%s\n' "$relpaths" | LC_ALL=C awk -F'/' '
        {
            skip = 0
            for (i = 1; i <= NF; i++) {
                if ($i == "evals" || $i == "install-assets" || $i == "__pycache__") { skip = 1; break }
            }
            if (!skip && $NF ~ /\.pyc$/) skip = 1
            if (!skip) print $0
        }
    ')"
    [[ -z "$kept" ]] && { printf ''; return 0; }

    sorted="$(printf '%s\n' "$kept" | LC_ALL=C sort)"

    local rel h
    {
        while IFS= read -r rel; do
            [[ -z "$rel" ]] && continue
            h="$(mti_sha256_file "$dir/$rel")" || return 1
            printf '%s\0%s\n' "$rel" "$h"
        done <<< "$sorted"
    } | _mti_sha256_stream
}
