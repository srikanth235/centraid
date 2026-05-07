#!/usr/bin/env python3
"""Agent steering accounting ledger — parse, append, validate STEERING.md rows.

This module is the data-processing half of agent-steering-accounting. The bash
hooks and directive scripts do git plumbing and runtime detection; anything
that manipulates STEERING.md rows by name rather than by column index lives
here.

Schema (7 columns):

    | steer-key | session | issue | type | tier | user-reason | commit |

Where:
    type ∈ interrupt | correction
    tier ∈ structural | classifier | lexical
    steer-key = steer-<session-short>-<epoch>-<idx>

Stdlib-only. CLI shims (called from bash):

    python3 ledger.py validate <ledger>
        → prints one violation per line; exits non-zero if any.

    python3 ledger.py find-by-steer-key <ledger> <key>
        → exit 0 if exactly 1 row, 2 if 0, 3 if >1; prints the row's
          remaining cells space-separated on stdout.

    python3 ledger.py existing-keys <ledger>
        → prints every steer-key present, one per line.

    python3 ledger.py append-row <ledger> <steer-key> <session> <issue> \\
                                  <type> <tier> <user-reason> <commit>
        → appends the row, creating the file with the canonical header
          if it doesn't yet exist.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from pathlib import Path


# ── Schema ────────────────────────────────────────────────────────────────

COLUMNS = (
    "steer_key",
    "session",
    "issue",
    "type",
    "tier",
    "user_reason",
    "commit",
)

LEDGER_TEMPLATE = """\
<!-- STEERING.md — append-only human-steering ledger -->
<!-- governance: allow-plan-captured -->

# STEERING.md

Append-only ledger of human-steering events for agent-authored commits. Rows are
keyed by `steer-key`; the row → commit join uses the `commit |` column so the
ledger survives squash merges that strip the original commit history. Each
commit's summary trailers (`Steer-Count`, `Steer-Types`, `Steer-Tiers`) tally
the rows it adds.

**Do not** rewrite or reorder rows. This file is the durable record that the
`agent-steering-accounting` governance directive validates.

`type` ∈ `interrupt` | `correction` ·
`tier` ∈ `structural` | `classifier` | `lexical` (the lexical tier is a
silent fallback for when the runtime CLI is unreachable).

## Ledger

| steer-key | session | issue | type | tier | user-reason | commit |
| --- | --- | --- | --- | --- | --- | --- |
"""

VALID_TYPES = {"interrupt", "correction"}
VALID_TIERS = {"structural", "classifier", "lexical"}

COLUMN_COUNT = 7

# steer-<session-short>-<epoch>-<idx>
_STEER_KEY_RE = re.compile(r"^steer-[A-Za-z0-9]+-(\d+)-(\d+)$")
_ISSUE_RE = re.compile(r"^#[1-9][0-9]*$")
USER_REASON_MAX = 240


@dataclass
class LedgerRow:
    steer_key: str = ""
    session: str = ""
    issue: str = ""
    type: str = ""
    tier: str = ""
    user_reason: str = ""
    commit: str = ""

    def to_cells(self) -> list[str]:
        return [
            self.steer_key,
            self.session,
            self.issue,
            self.type,
            self.tier,
            self.user_reason,
            self.commit,
        ]


# ── Parse ─────────────────────────────────────────────────────────────────


def _parse_cells(line: str) -> list[str] | None:
    stripped = line.strip()
    if not stripped.startswith("|"):
        return None
    parts = [c.strip() for c in stripped.split("|")[1:-1]]
    return parts or None


def _is_header_or_separator(cells: list[str]) -> bool:
    if not cells:
        return True
    first = cells[0]
    if first == "steer-key":
        return True
    if first == "" or re.fullmatch(r"-+", first or ""):
        return True
    if all(c == "" or re.fullmatch(r"-+", c) for c in cells):
        return True
    return False


def parse(path: str | Path) -> list[LedgerRow]:
    p = Path(path)
    if not p.is_file():
        return []
    rows: list[LedgerRow] = []
    for line in p.read_text().splitlines():
        cells = _parse_cells(line)
        if cells is None or _is_header_or_separator(cells):
            continue
        if len(cells) != COLUMN_COUNT:
            # Validation surfaces malformed rows separately; parsing skips them.
            continue
        rows.append(LedgerRow(*cells))
    return rows


# ── Queries ───────────────────────────────────────────────────────────────


def find_by_steer_key(rows: list[LedgerRow], key: str) -> list[LedgerRow]:
    return [r for r in rows if r.steer_key == key]


def existing_keys(rows: list[LedgerRow]) -> list[str]:
    return [r.steer_key for r in rows if r.steer_key]


# ── Append ────────────────────────────────────────────────────────────────


def _safe_cell(s: str, *, max_len: int | None = None) -> str:
    cleaned = "".join(ch for ch in s if ch.isprintable() and ch != "|")
    if "\\" in cleaned:
        cleaned = cleaned.split("\\", 1)[0]
    cleaned = cleaned.strip()
    if max_len is not None and len(cleaned) > max_len:
        cleaned = cleaned[: max_len - 1] + "…"
    return cleaned


def append_row(path: str | Path, row: LedgerRow) -> None:
    p = Path(path)
    if not p.exists():
        p.write_text(LEDGER_TEMPLATE)
    cells = row.to_cells()
    # Per-cell sanitization: kill pipes/newlines, truncate user-reason and
    # commit columns so a runaway transcript can't bloat the ledger.
    cells = [
        _safe_cell(cells[0]),                              # steer-key
        _safe_cell(cells[1]),                              # session
        _safe_cell(cells[2]),                              # issue
        _safe_cell(cells[3]),                              # type
        _safe_cell(cells[4]),                              # tier
        _safe_cell(cells[5], max_len=USER_REASON_MAX),     # user-reason
        _safe_cell(cells[6], max_len=80),                  # commit
    ]
    line = "| " + " | ".join(cells) + " |\n"
    with p.open("a") as f:
        f.write(line)


# ── Validate ──────────────────────────────────────────────────────────────


def validate(path: str | Path) -> list[str]:
    """Walk the ledger, return violation strings.

    Checks:
        - Every data row has exactly COLUMN_COUNT cells.
        - steer-key matches `steer-<session-short>-<epoch>-<idx>`.
        - type ∈ VALID_TYPES, tier ∈ VALID_TIERS.
        - issue matches `#N` (when non-empty — empty is allowed for legacy
          commits that didn't carry an issue anchor).
        - session non-empty.
        - steer-key unique.
        - Row order is monotonically non-decreasing in the embedded epoch
          (append-only — never reorder rows).
    """
    p = Path(path)
    if not p.is_file():
        return []

    violations: list[str] = []
    seen: dict[str, int] = {}
    last_epoch = -1

    for line_no, line in enumerate(p.read_text().splitlines(), start=1):
        cells = _parse_cells(line)
        if cells is None or _is_header_or_separator(cells):
            continue
        if len(cells) != COLUMN_COUNT:
            violations.append(
                f"STEERING.md:{line_no} — row has {len(cells)} cells, expected {COLUMN_COUNT}"
            )
            continue

        steer_key, session, issue, typ, tier, _reason, _commit = cells

        if not steer_key:
            violations.append(f"STEERING.md:{line_no} — empty steer-key")
            continue

        m = _STEER_KEY_RE.match(steer_key)
        if not m:
            violations.append(
                f"STEERING.md — row '{steer_key}' has malformed steer-key "
                f"(expected steer-<session-short>-<epoch>-<idx>)"
            )
        else:
            epoch = int(m.group(1))
            if epoch < last_epoch:
                violations.append(
                    f"STEERING.md — row '{steer_key}' is out of order "
                    f"(epoch {epoch} < previous {last_epoch}; ledger is append-only)"
                )
            last_epoch = max(last_epoch, epoch)

        if not session:
            violations.append(f"STEERING.md — row '{steer_key}' has empty session")
        if issue and not _ISSUE_RE.match(issue):
            violations.append(
                f"STEERING.md — row '{steer_key}' issue '{issue}' must look like '#123'"
            )
        if typ not in VALID_TYPES:
            violations.append(
                f"STEERING.md — row '{steer_key}' has unknown type '{typ}' "
                f"(expected one of: {', '.join(sorted(VALID_TYPES))})"
            )
        if tier not in VALID_TIERS:
            violations.append(
                f"STEERING.md — row '{steer_key}' has unknown tier '{tier}' "
                f"(expected one of: {', '.join(sorted(VALID_TIERS))})"
            )

        seen[steer_key] = seen.get(steer_key, 0) + 1

    for key, count in seen.items():
        if count > 1:
            violations.append(
                f"STEERING.md — steer-key '{key}' appears {count} times (must be unique, append-only)"
            )

    return violations


# ── CLI ───────────────────────────────────────────────────────────────────


def _die(msg: str) -> None:
    print(f"ledger: {msg}", file=sys.stderr)
    sys.exit(2)


def _cmd_validate(args: list[str]) -> int:
    if len(args) != 1:
        _die("validate takes: <ledger>")
    violations = validate(args[0])
    for v in violations:
        print(v)
    return 1 if violations else 0


def _cmd_find_by_steer_key(args: list[str]) -> int:
    if len(args) != 2:
        _die("find-by-steer-key takes: <ledger> <key>")
    rows = parse(args[0])
    hits = find_by_steer_key(rows, args[1])
    if len(hits) == 0:
        print(f"steer-key '{args[1]}' not found", file=sys.stderr)
        return 2
    if len(hits) > 1:
        print(f"steer-key '{args[1]}' appears {len(hits)} times", file=sys.stderr)
        return 3
    r = hits[0]
    print(f"{r.session} {r.type} {r.tier} {r.commit}")
    return 0


def _cmd_existing_keys(args: list[str]) -> int:
    if len(args) != 1:
        _die("existing-keys takes: <ledger>")
    for k in existing_keys(parse(args[0])):
        print(k)
    return 0


def _cmd_append_row(args: list[str]) -> int:
    if len(args) != 8:
        _die(
            "append-row takes: <ledger> <steer-key> <session> <issue> "
            "<type> <tier> <user-reason> <commit>"
        )
    ledger, steer_key, session, issue, typ, tier, reason, commit = args
    if typ not in VALID_TYPES:
        _die(f"unknown type {typ!r}")
    if tier not in VALID_TIERS:
        _die(f"unknown tier {tier!r}")
    if not _STEER_KEY_RE.match(steer_key):
        _die(f"malformed steer-key {steer_key!r}")
    append_row(
        ledger,
        LedgerRow(
            steer_key=steer_key,
            session=session,
            issue=issue,
            type=typ,
            tier=tier,
            user_reason=reason,
            commit=commit,
        ),
    )
    return 0


_COMMANDS = {
    "validate": _cmd_validate,
    "find-by-steer-key": _cmd_find_by_steer_key,
    "existing-keys": _cmd_existing_keys,
    "append-row": _cmd_append_row,
}


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0 if argv else 2
    cmd, rest = argv[0], argv[1:]
    if cmd not in _COMMANDS:
        _die(f"unknown command {cmd!r}; try one of: {', '.join(sorted(_COMMANDS))}")
    return _COMMANDS[cmd](rest)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
