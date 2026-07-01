#!/usr/bin/env python3
"""managed-tree-integrity (issue #253) — offline verification that the
`.governance/` managed tree matches the content digests recorded at apply time.

Runs under the repo's bare `python3` in the pre-commit hook and in CI, so it is
**stdlib only** — no PyYAML. It hand-parses the two digest stores the apply
verbs write:

  * `.governance/packs.lock` — each pack entry's `digest:` map
    (`{<directive-id>: <sha256>}`), recorded by init / pack-apply.
  * `.governance/install.yaml` — the top-level `managed_digests:` map
    (`{<relpath>: <sha256>}`) for the kit-runtime files.

For each recorded unit it recomputes the digest on disk and compares. The
`file_digest` / `directory_digest` routines are a byte-identical copy of
`kit/assets/packs/lib/digestlib.py`; `scripts/test-digestlib.py` pins them
together.

Back-compat: a pack entry with no `digest` (or a manifest with no
`managed_digests`) is skipped — installs predating issue #253 carry no digests
and gain coverage on their next `pack update` / `kit update`. New installs are
covered from day one.

Usage: integrity.py <repo-root> [<waived-unit> ...]
Prints one violation per line to stdout (exit 0 always; the check.sh wrapper
counts them).
"""
from __future__ import annotations

import hashlib
import sys
from pathlib import Path

EXCLUDED_DIRS = ("evals", "install-assets", "__pycache__")

# Seed-once sweep-lane assets (issue #259): the apply engines digest-record them
# (via digestlib.managed_runtime_files), but they are *seeded* with the kit
# version current at seed time and never re-stamped on a kit update — unlike the
# three manifest-scalar runtime files (run.sh, lib.sh, the CI workflow), nothing
# re-renders them forward. Their
# `kit-version=` marker therefore legitimately diverges from the manifest pin, so
# they are exempt from the marker-version equality check below (issue #263). The
# digest check still guards their content fully — the marker line is inside the
# digested bytes — so a hand-edit is still caught. Mirrors applylib.SWEEP_ASSETS.
SWEEP_ASSET_RELPATHS = (
    ".github/workflows/governance-sweep.yml",
    ".governance/sweep.py",
)


# ── digest (must stay byte-identical to digestlib.py) ───────────────────────
def file_digest(path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def directory_digest(directory) -> str:
    directory = Path(directory)
    if not directory.is_dir():
        return ""
    pairs = []
    for p in directory.rglob("*"):
        if not p.is_file():
            continue
        rel = p.relative_to(directory)
        if any(part in EXCLUDED_DIRS for part in rel.parts):
            continue
        if p.suffix == ".pyc":
            continue
        pairs.append((rel.as_posix(), p))
    pairs.sort(key=lambda t: t[0])
    if not pairs:
        return ""
    h = hashlib.sha256()
    for rel, p in pairs:
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        h.update(file_digest(p).encode("ascii"))
        h.update(b"\n")
    return h.hexdigest()


# ── tiny stdlib parsers for the two digest stores ───────────────────────────
def parse_lock(path: Path) -> list[dict]:
    """Return [{id, directives:[...], digest:{did:sha} or None}]. `digest` is
    None when the pack entry has no `digest:` key (legacy → skipped)."""
    if not path.is_file():
        return []
    packs: list[dict] = []
    cur: dict | None = None
    mode = None  # "directives" | "digest" | None
    for raw in path.read_text().splitlines():
        if raw.startswith("- id:"):
            cur = {"id": raw.split(":", 1)[1].strip(), "directives": [], "digest": None}
            packs.append(cur)
            mode = None
            continue
        if cur is None:
            continue
        if raw.startswith("  directives:"):
            mode = "directives"
            continue
        if raw.startswith("  digest:"):
            # `  digest: {}` (empty inline) or a block map below.
            rest = raw.split(":", 1)[1].strip()
            cur["digest"] = {}
            mode = None if rest == "{}" else "digest"
            continue
        if raw.startswith("  - ") and mode == "directives":
            cur["directives"].append(raw[4:].strip())
            continue
        if raw.startswith("    ") and mode == "digest":
            k, _, v = raw.strip().partition(":")
            if k:
                cur["digest"][k.strip()] = v.strip()
            continue
        # Any other 2-space scalar field ends a list/map block.
        if raw.startswith("  ") and not raw.startswith("    ") and not raw.startswith("  - "):
            mode = None
    return packs


def manifest_scalar(path: Path, key: str) -> str:
    if not path.is_file():
        return ""
    import re
    m = re.search(rf"(?m)^{re.escape(key)}:[ \t]*['\"]?([^'\"#\s]*)['\"]?", path.read_text())
    return m.group(1) if m else ""


def marker_version(path: Path) -> str:
    """The kit-version stamped in a managed file's `# governance-kit:managed
    kit-version=<v>` marker (first few lines), or "" if unmarked."""
    if not path.is_file():
        return ""
    import re
    for line in path.read_text().splitlines()[:3]:
        m = re.search(r"governance-kit:managed.*kit-version=([^\s]+)", line)
        if m:
            return m.group(1)
    return ""


def parse_managed_digests(path: Path):
    """Return {relpath: sha} from install.yaml's `managed_digests:` block, or
    None when the key is absent (legacy → skipped)."""
    if not path.is_file():
        return None
    out: dict[str, str] | None = None
    in_block = False
    for raw in path.read_text().splitlines():
        if raw.startswith("managed_digests:"):
            rest = raw.split(":", 1)[1].strip()
            out = {}
            in_block = rest != "{}"
            continue
        if in_block:
            if raw.startswith("  ") and not raw.lstrip().startswith("#"):
                k, _, v = raw.strip().partition(":")
                if k:
                    out[k.strip()] = v.strip()
                continue
            # dedent / next top-level key ends the block
            if raw and not raw.startswith(" "):
                in_block = False
    return out


# ── check ───────────────────────────────────────────────────────────────────
def main(argv: list[str]) -> int:
    root = Path(argv[0]) if argv else Path(".")
    waived = set(argv[1:])
    violations: list[str] = []

    def report(unit: str, msg: str):
        if unit not in waived:
            violations.append(msg)

    packs_dir = root / ".governance" / "packs"

    # (a) vendored pack directive folders
    for pack in parse_lock(root / ".governance" / "packs.lock"):
        pid = pack["id"]
        recorded = pack["digest"]
        if recorded is None:
            continue  # back-compat: legacy entry, no digests recorded
        pack_root = packs_dir / pid
        for did, want in sorted(recorded.items()):
            folder = pack_root / "directives" / did
            unit = f"{pid}/{did}"
            if not folder.is_dir():
                report(unit, f"{unit}: managed directive folder is missing — restore via 'governance pack update'")
                continue
            got = directory_digest(folder)
            if got != want:
                report(unit, f"{unit}: content drifted from the digest recorded at apply time — "
                             f"hand-edited or stale; re-run 'governance pack update' (do not hand-edit .governance/)")
        # orphan directive folder: present on disk but not recorded
        disk_dir = pack_root / "directives"
        if disk_dir.is_dir():
            for child in sorted(disk_dir.iterdir()):
                if child.is_dir() and child.name not in recorded and child.name not in pack["directives"]:
                    unit = f"{pid}/{child.name}"
                    report(unit, f"{unit}: directive folder is not recorded in packs.lock — "
                                 f"installed by hand; add it via 'governance pack add/update' or remove it")

    # (b) kit-runtime managed files
    manifest = root / ".governance" / "install.yaml"
    recorded_rt = parse_managed_digests(manifest)
    if recorded_rt is not None:
        kit_version = manifest_scalar(manifest, "kit_version")
        for rel, want in sorted(recorded_rt.items()):
            f = root / rel
            if not f.is_file():
                report(rel, f"{rel}: managed kit-runtime file is missing — restore via 'governance update'")
                continue
            if file_digest(f) != want:
                report(rel, f"{rel}: kit-runtime file drifted from the digest recorded at apply time — "
                            f"hand-edited or stale; re-run 'governance update' (do not hand-edit .governance/)")
                continue
            # Marker / manifest consistency (subsumes the former kit-version-sync):
            # a hand-edited manifest kit_version leaves the files matching their
            # recorded digests, so the digest alone can't catch it — compare the
            # file's stamped marker to the manifest's kit_version. Seed-once sweep
            # assets are exempt: they carry their seed-time marker and are never
            # re-stamped on a kit update, so marker != pin is expected, not drift
            # (issue #263). The digest check above still guards their content.
            if rel in SWEEP_ASSET_RELPATHS:
                continue
            mv = marker_version(f)
            if kit_version and mv and mv != kit_version:
                report(rel, f"{rel}: stamped kit-version={mv} but install.yaml pins kit_version={kit_version} "
                            f"— half-applied update or an out-of-band version edit; re-run 'governance update'")

    for v in violations:
        print(v)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
