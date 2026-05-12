#!/usr/bin/env python3
"""Commit-trailer parsing for agent-steering-accounting (summary-only contract).

Every non-merge, non-revert commit stamps the always-on summary triple:

    Steer-Count: <N>
    Steer-Types: <type>=<N>,...   (sorted, or `none` on N=0)
    Steer-Tiers: <tier>=<N>,...   (sorted, or `none` on N=0)

`Steer-Count` equals the number of rows newly added to STEERING.md by this
commit; the type / tier breakdowns agree with those rows' `type` / `tier`
columns and total to `Steer-Count`. The row → commit join uses STEERING.md's
`commit |` column — the per-event `Steer-Key:` trailer that earlier versions
stamped is retired (issue #66). Historical commits in the repo's log may
still carry `Steer-Key:` trailers; the new validator ignores them.

The directive is independent of `agent-token-accounting`: the contract
applies to every in-scope commit, not just commits carrying an `Agent:`
trailer. Installation is the gate.

CLI:

    python3 trailers.py validate <label> <ledger> [--subject SUBJECT] \\
            <msg_file|-> [<added-key>...]
        Reads the commit message and the list of steer-keys newly added to
        STEERING.md by this commit (computed by the caller from the
        STEERING.md diff). Emits one violation per line; exits 1 if any,
        0 otherwise. `--subject` enables the row.commit-cell == subject
        check (Mode A only — squash-merge can rewrite the subject after
        the row was stamped, so Mode B passes without it).
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

# ledger.py sits next to this file; relative import works under
# `python3 trailers.py …` because the parent dir is on sys.path.
try:
    from ledger import parse as parse_ledger  # type: ignore
except ModuleNotFoundError:  # pragma: no cover
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from ledger import parse as parse_ledger  # type: ignore


_SCALAR_TRAILER_RE = re.compile(r"^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$")
_COUNT_BREAKDOWN_RE = re.compile(r"^([a-z][a-z-]*=\d+)(,[a-z][a-z-]*=\d+)*$")


def extract_scalar_trailers(msg: str) -> dict[str, str]:
    """Last-wins parse for scalar trailers."""
    out: dict[str, str] = {}
    for line in msg.splitlines():
        m = _SCALAR_TRAILER_RE.match(line)
        if m:
            out[m.group(1)] = m.group(2).strip()
    return out


def _parse_breakdown(value: str) -> dict[str, int] | None:
    """Parse `key=N,key=N` into a dict, or `none` → {}. None on malformed."""
    if value == "none" or value == "":
        return {}
    if not _COUNT_BREAKDOWN_RE.match(value):
        return None
    out: dict[str, int] = {}
    for chunk in value.split(","):
        k, _, v = chunk.partition("=")
        out[k] = int(v)
    return out


def _format_breakdown(d: dict[str, int]) -> str:
    if not d:
        return "none"
    return ",".join(f"{k}={d[k]}" for k in sorted(d))


def _subject_matches(row_commit: str, subject: str) -> bool:
    """Match the row's `commit |` cell against the pending subject.

    Tolerant of two known imperfections of how the cell is stamped:
      - ledger.py's 80-char truncation appends `…` for long subjects.
      - the pre-commit argv-walker may include trailing argv noise on the
        cell when the user invoked `git commit -m "..."` with extra flags
        after the message (the regex captures `(.+)` greedily).
    """
    cell = row_commit[:-1] if row_commit.endswith("…") else row_commit
    return subject.startswith(cell) or cell.startswith(subject)


def _tally(rows, attr: str) -> dict[str, int]:
    out: dict[str, int] = {}
    for r in rows:
        v = getattr(r, attr)
        out[v] = out.get(v, 0) + 1
    return out


def validate(
    msg: str,
    label: str,
    ledger_path: str | Path,
    added_keys: list[str],
    *,
    subject: str | None,
) -> list[str]:
    """Cross-check summary trailers against rows newly added by this commit.

    `added_keys` are the steer-keys parsed from the STEERING.md diff (Mode A:
    staged diff; Mode B: `git show <sha>` diff). `subject`, when not None, is
    the pending commit's subject for the row.commit-cell check; pass None in
    Mode B.
    """
    violations: list[str] = []
    scalars = extract_scalar_trailers(msg)
    has_count = "Steer-Count" in scalars
    has_types = "Steer-Types" in scalars
    has_tiers = "Steer-Tiers" in scalars

    # Every in-scope commit — full summary triple required, even at N=0.
    missing = [
        name
        for name, present in (
            ("Steer-Count", has_count),
            ("Steer-Types", has_types),
            ("Steer-Tiers", has_tiers),
        )
        if not present
    ]
    if missing:
        violations.append(
            f"{label} — commit missing summary trailer(s): {', '.join(missing)}"
        )
        return violations

    count_val = scalars["Steer-Count"]
    if not count_val.isdigit():
        violations.append(
            f"{label} — Steer-Count {count_val!r} must be a non-negative integer"
        )
        return violations
    expected_count = int(count_val)

    types_parsed = _parse_breakdown(scalars["Steer-Types"])
    tiers_parsed = _parse_breakdown(scalars["Steer-Tiers"])
    if types_parsed is None:
        violations.append(
            f"{label} — Steer-Types {scalars['Steer-Types']!r} is malformed "
            f"(expected `key=N,key=N` or `none`)"
        )
    if tiers_parsed is None:
        violations.append(
            f"{label} — Steer-Tiers {scalars['Steer-Tiers']!r} is malformed "
            f"(expected `key=N,key=N` or `none`)"
        )

    if types_parsed is not None and sum(types_parsed.values()) != expected_count:
        violations.append(
            f"{label} — Steer-Types totals to {sum(types_parsed.values())}, "
            f"expected {expected_count}"
        )
    if tiers_parsed is not None and sum(tiers_parsed.values()) != expected_count:
        violations.append(
            f"{label} — Steer-Tiers totals to {sum(tiers_parsed.values())}, "
            f"expected {expected_count}"
        )

    if expected_count != len(added_keys):
        violations.append(
            f"{label} — Steer-Count ({expected_count}) != newly-added rows in "
            f"STEERING.md ({len(added_keys)})"
        )

    rows = parse_ledger(ledger_path)
    by_key = {r.steer_key: r for r in rows}
    matched = []
    for k in added_keys:
        r = by_key.get(k)
        if r is None:
            violations.append(
                f"{label} — STEERING.md diff added row {k!r} but it is not "
                f"present in the parsed ledger"
            )
        else:
            matched.append(r)

    if matched:
        actual_types = _tally(matched, "type")
        actual_tiers = _tally(matched, "tier")
        if types_parsed is not None and types_parsed != actual_types:
            violations.append(
                f"{label} — Steer-Types {scalars['Steer-Types']} disagrees with "
                f"newly-added rows' types {_format_breakdown(actual_types)}"
            )
        if tiers_parsed is not None and tiers_parsed != actual_tiers:
            violations.append(
                f"{label} — Steer-Tiers {scalars['Steer-Tiers']} disagrees with "
                f"newly-added rows' tiers {_format_breakdown(actual_tiers)}"
            )

    if subject is not None:
        for r in matched:
            if r.commit and not _subject_matches(r.commit, subject):
                violations.append(
                    f"{label} — STEERING.md row {r.steer_key!r} has commit "
                    f"cell {r.commit!r} which does not match pending subject "
                    f"{subject!r}"
                )

    return violations


# ── CLI ───────────────────────────────────────────────────────────────────


def _read_msg(path_or_dash: str) -> str:
    if path_or_dash == "-":
        return sys.stdin.read()
    return Path(path_or_dash).read_text()


def _cmd_validate(argv: list[str]) -> int:
    if len(argv) < 3:
        print(
            "trailers validate: <label> <ledger> [--subject SUBJECT] "
            "<msg|-> [added-key...]",
            file=sys.stderr,
        )
        return 2
    label, ledger = argv[0], argv[1]
    rest = argv[2:]
    subject: str | None = None
    if rest and rest[0] == "--subject":
        if len(rest) < 2:
            print("--subject requires a value", file=sys.stderr)
            return 2
        subject = rest[1]
        rest = rest[2:]
    if not rest:
        print("missing <msg|->", file=sys.stderr)
        return 2
    msg_src, added_keys = rest[0], rest[1:]
    msg = _read_msg(msg_src)
    violations = validate(msg, label, ledger, added_keys, subject=subject)
    for v in violations:
        print(v)
    return 1 if violations else 0


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0 if argv else 2
    cmd, rest = argv[0], argv[1:]
    if cmd == "validate":
        return _cmd_validate(rest)
    print(f"trailers: unknown command {cmd!r}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
