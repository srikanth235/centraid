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
# Heavy lifting (digest recompute + stdlib lock/manifest parse) lives in
# lib/integrity.py: stdlib only, one violation per line, exit 0 unless it
# crashes. Per-unit waivers come from the conf overlay (see defaults.conf).
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "managed-tree-integrity"
require_git
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT" || exit 1
HERE="$(cd "$(dirname "$0")" && pwd)"

# Waived units (pack/directive ids or runtime relpaths) from the conf overlay,
# layered on the (empty) pack default. Passed as args to the helper. The
# `${waived[@]+...}` expansion keeps an empty array safe under set -u on bash 3.2.
waived=()
while IFS= read -r u; do
    [[ -n "$u" ]] && waived+=("$u")
done < <(conf_list managed-tree-integrity "$HERE/defaults.conf")

if ! out="$(python3 "$HERE/lib/integrity.py" "$ROOT" ${waived[@]+"${waived[@]}"})"; then
    violation "managed-tree-integrity helper crashed — see stderr above"
fi
while IFS= read -r line; do
    [[ -n "$line" ]] && violation "$line"
done <<< "$out"

directive_end
