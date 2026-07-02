#!/usr/bin/env python3
"""Agent steering accounting — parse, append, validate steering rows.

Steering rows live in per-issue receipts (issue #201): each row is appended
under the `## Accounting` → `### Steering` sub-table of `receipts/issue-<N>.md`,
not in a central `STEERING.md`. The receipt is the conflict-free,
naturally-sealed home; `STEERING.md` is sealed history this flow no longer
reads or writes.

Row schema — v2 (9 columns, issue #229):

    | steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |

`ordinal` and `timestamp` are the event's **absolute transcript coordinates**:
`ordinal` is its 1-based position in the session's deterministic event stream,
`timestamp` the ISO time the extractor already emits. Dedup is now
identity-based — a `(session, ordinal)` pair is appended once, ever — instead of
the old positional "skip the first N transcript events". The pair is also what
makes a cross-branch duplicate *detectable*: the same event re-appended on a
sibling branch lands a second row with the same `(session, ordinal)`, which the
validator flags.

`type` ∈ interrupt | correction · `tier` ∈ structural | classifier | lexical ·
`steer-key` = steer-<session-short>-<epoch>-<idx> · `issue` = #N (required —
every accounted event resolves to an issue, which is the receipt that homes it).

Legacy v1 rows (7 columns, no `ordinal`/`timestamp`) keep parsing and are
validated to the v1 rules; the ordinal duplicate / monotonicity checks apply to
v2 rows only.

Markdown section/table plumbing lives in sibling `receipt_io.py`. Stdlib-only.
CLI shims (called from the bash hook / check):

    resolve-receipt    <receipts_dir> <issue>    → receipt path for issue N
    count-by-session   <receipts_dir> <session>  → #rows for session
    existing-ordinals  <receipts_dir> <session>  → ordinals already recorded (dedup)
    validate           <receipt>                 → one violation per line
    validate-dir       <receipts_dir>            → all receipts + global uniqueness
    find-by-steer-key  <receipts_dir> <key>      → "<session> <type> <tier> <commit>"
    append-row         <receipt> <steer-key> <session> <issue> <type> <tier> \\
                       <user-reason> <commit> <ordinal> <timestamp>
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from pathlib import Path

# Don't write __pycache__ into the installed directive folder — it would
# litter the consumer's `.governance/packs/` and trip repo-hygiene.
sys.dont_write_bytecode = True

try:
    import receipt_io as rio
except ModuleNotFoundError:  # pragma: no cover
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import receipt_io as rio


COLUMNS = (
    "steer_key", "session", "issue", "type", "tier", "user_reason", "commit",
    "ordinal", "timestamp",
)
# v2 adds ordinal + timestamp; v1 is the 7-column predecessor.
V2_COLS = 9
V1_COLS = 7

STEER_HEADER = (
    "| steer-key | session | issue | type | tier | user-reason | commit "
    "| ordinal | timestamp |"
)
STEER_SEPARATOR = "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"

VALID_TYPES = {"interrupt", "correction"}
VALID_TIERS = {"structural", "classifier", "lexical"}

_STEER_KEY_RE = re.compile(r"^steer-[A-Za-z0-9]+-(\d+)-(\d+)$")
_ISSUE_RE = re.compile(r"^#[1-9][0-9]*$")
_INT_RE = re.compile(r"^\d+$")
_RECEIPT_NAME_RE = re.compile(r"^issue-([1-9][0-9]*)(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?\.md$")
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
    # v2 transcript coordinates — None / "" on legacy v1 rows.
    ordinal: int | None = None
    timestamp: str = ""

    @property
    def has_ordinal(self) -> bool:
        return self.ordinal is not None

    def to_cells(self) -> list[str]:
        ord_cell = "" if self.ordinal is None else str(self.ordinal)
        return [
            self.steer_key, self.session, self.issue, self.type,
            self.tier, self.user_reason, self.commit, ord_cell, self.timestamp,
        ]


def _row_from_cells(cells: list[str]) -> LedgerRow | None:
    if len(cells) == V2_COLS:
        steer_key, session, issue, typ, tier, reason, commit, ordinal, ts = cells
        ord_val = int(ordinal) if _INT_RE.match(ordinal or "") else None
        return LedgerRow(
            steer_key=steer_key, session=session, issue=issue, type=typ, tier=tier,
            user_reason=reason, commit=commit, ordinal=ord_val, timestamp=ts,
        )
    if len(cells) == V1_COLS:
        return LedgerRow(*cells)
    return None


def _issue_from_name(name: str) -> str | None:
    m = _RECEIPT_NAME_RE.match(name)
    return f"#{m.group(1)}" if m else None


# ── Parse ─────────────────────────────────────────────────────────────────


def parse_steering(path: str | Path) -> list[LedgerRow]:
    """Parse the steering rows from one receipt's `### Steering` sub-table."""
    p = Path(path)
    if not p.is_file():
        return []
    lines = p.read_text().splitlines()
    region = rio.subtable_region(lines, rio.STEERING_SUBHEADING)
    if region is None:
        return []
    rows: list[LedgerRow] = []
    for idx in range(*region):
        cells = rio.parse_cells(lines[idx])
        if cells is None or rio.is_header_or_separator(cells, "steer-key"):
            continue
        row = _row_from_cells(cells)
        if row is not None:
            rows.append(row)
    return rows


parse = parse_steering  # alias


def parse_all(receipts_dir: str | Path) -> list[LedgerRow]:
    d = Path(receipts_dir)
    rows: list[LedgerRow] = []
    if d.is_dir():
        for f in sorted(d.glob("issue-*.md")):
            rows.extend(parse_steering(f))
    return rows


# ── Queries ───────────────────────────────────────────────────────────────


def find_by_steer_key(rows: list[LedgerRow], key: str) -> list[LedgerRow]:
    return [r for r in rows if r.steer_key == key]


def existing_keys(rows: list[LedgerRow]) -> list[str]:
    return [r.steer_key for r in rows if r.steer_key]


def count_by_session(rows: list[LedgerRow], session: str) -> int:
    return sum(1 for r in rows if r.session == session)


def existing_ordinals(rows: list[LedgerRow], session: str) -> list[int]:
    """Ordinals already recorded for `session` — the identity-dedup boundary.

    The pre-commit hook appends an extracted event only when its ordinal is not
    already in this set (instead of the old positional "skip the first N").
    """
    return sorted(
        {r.ordinal for r in rows if r.session == session and r.ordinal is not None}
    )


def resolve_receipt(receipts_dir: str | Path, issue_number: str) -> str:
    n = issue_number.lstrip("#")
    d = Path(receipts_dir)
    pat = re.compile(rf"^issue-{re.escape(n)}(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?\.md$")
    if d.is_dir():
        matches = sorted(p.name for p in d.iterdir() if p.is_file() and pat.match(p.name))
        if matches:
            return str(d / matches[0])
    return str(d / f"issue-{n}.md")


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
    cells = row.to_cells()
    cells = [
        _safe_cell(cells[0]), _safe_cell(cells[1]), _safe_cell(cells[2]),
        _safe_cell(cells[3]), _safe_cell(cells[4]),
        _safe_cell(cells[5], max_len=USER_REASON_MAX),
        _safe_cell(cells[6], max_len=80),
        _safe_cell(cells[7]), _safe_cell(cells[8]),
    ]
    row_line = "| " + " | ".join(cells) + " |"
    rio.write_row(path, rio.STEERING_SUBHEADING, STEER_HEADER, STEER_SEPARATOR, row_line)


# ── Validate ──────────────────────────────────────────────────────────────


def validate(path: str | Path) -> list[str]:
    """Validate one receipt's `### Steering` sub-table.

    Checks: 7 (v1) or 9 (v2) cells; well-formed steer-key; type/tier in the
    allowed sets; issue is `#N` and equals this receipt's own issue (issue #201,
    decision 6 — every event resolves to an issue); session non-empty; steer-key
    unique; rows in non-decreasing embedded-epoch order (append-only). For v2
    rows additionally: `ordinal` is a positive integer and is strictly
    increasing per session in file order (issue #229).
    """
    p = Path(path)
    if not p.is_file():
        return []
    name = p.name
    lines = p.read_text().splitlines()
    region = rio.subtable_region(lines, rio.STEERING_SUBHEADING)
    if region is None:
        return []
    issue_n = _issue_from_name(name)

    violations: list[str] = []
    seen: dict[str, int] = {}
    last_epoch = -1
    last_ordinal_by_session: dict[str, int] = {}

    for idx in range(*region):
        cells = rio.parse_cells(lines[idx])
        if cells is None or rio.is_header_or_separator(cells, "steer-key"):
            continue
        if len(cells) not in (V1_COLS, V2_COLS):
            violations.append(
                f"{name}:{idx + 1} — row has {len(cells)} cells, expected "
                f"{V1_COLS} (legacy) or {V2_COLS}"
            )
            continue

        steer_key = cells[0]
        session = cells[1]
        issue = cells[2]
        typ = cells[3]
        tier = cells[4]
        ordinal_cell = cells[7] if len(cells) == V2_COLS else None

        if not steer_key:
            violations.append(f"{name}:{idx + 1} — empty steer-key")
            continue

        m = _STEER_KEY_RE.match(steer_key)
        if not m:
            violations.append(
                f"{name} — row '{steer_key}' has malformed steer-key "
                f"(expected steer-<session-short>-<epoch>-<idx>)"
            )
        else:
            epoch = int(m.group(1))
            if epoch < last_epoch:
                violations.append(
                    f"{name} — row '{steer_key}' is out of order "
                    f"(epoch {epoch} < previous {last_epoch}; rows are append-only)"
                )
            last_epoch = max(last_epoch, epoch)

        if not session:
            violations.append(f"{name} — row '{steer_key}' has empty session")
        if not issue:
            violations.append(
                f"{name} — row '{steer_key}' has empty issue (every steering event "
                f"must resolve to an issue; receipt rows are never issue-less)"
            )
        elif not _ISSUE_RE.match(issue):
            violations.append(f"{name} — row '{steer_key}' issue '{issue}' must look like '#123'")
        elif issue_n is not None and issue != issue_n:
            violations.append(
                f"{name} — row '{steer_key}' issue '{issue}' does not match this "
                f"receipt's issue '{issue_n}'"
            )
        if typ not in VALID_TYPES:
            violations.append(
                f"{name} — row '{steer_key}' has unknown type '{typ}' "
                f"(expected one of: {', '.join(sorted(VALID_TYPES))})"
            )
        if tier not in VALID_TIERS:
            violations.append(
                f"{name} — row '{steer_key}' has unknown tier '{tier}' "
                f"(expected one of: {', '.join(sorted(VALID_TIERS))})"
            )

        # v2 ordinal: positive integer, strictly increasing per session.
        if ordinal_cell is not None:
            if not _INT_RE.match(ordinal_cell or "") or int(ordinal_cell) < 1:
                violations.append(
                    f"{name} — row '{steer_key}' has malformed ordinal "
                    f"'{ordinal_cell}' (expected a positive integer)"
                )
            elif session:
                ordn = int(ordinal_cell)
                prev = last_ordinal_by_session.get(session)
                if prev is not None and ordn <= prev:
                    violations.append(
                        f"{name} — row '{steer_key}' ordinal {ordn} is not greater "
                        f"than the previous ordinal {prev} for session "
                        f"'{session[:16]}…' (per-session ordinals are strictly "
                        f"increasing in append order)"
                    )
                last_ordinal_by_session[session] = max(ordn, prev or 0)

        seen[steer_key] = seen.get(steer_key, 0) + 1

    for key, count in seen.items():
        if count > 1:
            violations.append(f"{name} — steer-key '{key}' appears {count} times (must be unique)")
    return violations


def validate_dir(receipts_dir: str | Path) -> list[str]:
    """Validate every receipt's Steering sub-table plus global steer-key
    uniqueness and cross-receipt `(session, ordinal)` identity (issue #229)."""
    d = Path(receipts_dir)
    if not d.is_dir():
        return []
    violations: list[str] = []
    seen: dict[str, str] = {}
    # (session, ordinal) → receipt name, for cross-receipt duplicate detection.
    identity_seen: dict[tuple[str, int], str] = {}
    for f in sorted(d.glob("issue-*.md")):
        violations.extend(validate(f))
        for row in parse_steering(f):
            if row.steer_key:
                if row.steer_key in seen and seen[row.steer_key] != f.name:
                    violations.append(
                        f"receipts — steer-key '{row.steer_key}' appears in both "
                        f"{seen[row.steer_key]} and {f.name} (must be globally unique)"
                    )
                else:
                    seen.setdefault(row.steer_key, f.name)
            if row.ordinal is not None and row.session:
                ident = (row.session, row.ordinal)
                if ident in identity_seen:
                    violations.append(
                        f"receipts — steering event (session '{row.session[:16]}…', "
                        f"ordinal {row.ordinal}) appears in both "
                        f"{identity_seen[ident]} and {f.name} — the same transcript "
                        f"event was recorded twice (cross-branch re-append); drop the "
                        f"duplicate row or add a "
                        f"`governance: allow-agent-steering-accounting <reason>` waiver"
                    )
                else:
                    identity_seen[ident] = f.name
    return violations


# ── CLI ───────────────────────────────────────────────────────────────────


def _die(msg: str) -> None:
    print(f"ledger: {msg}", file=sys.stderr)
    sys.exit(2)


def _cmd_resolve_receipt(args: list[str]) -> int:
    if len(args) != 2:
        _die("resolve-receipt takes: <receipts_dir> <issue_number>")
    print(resolve_receipt(args[0], args[1]))
    return 0


def _cmd_count_by_session(args: list[str]) -> int:
    if len(args) != 2:
        _die("count-by-session takes: <receipts_dir> <session>")
    print(count_by_session(parse_all(args[0]), args[1]))
    return 0


def _cmd_existing_ordinals(args: list[str]) -> int:
    if len(args) != 2:
        _die("existing-ordinals takes: <receipts_dir> <session>")
    for o in existing_ordinals(parse_all(args[0]), args[1]):
        print(o)
    return 0


def _cmd_validate(args: list[str]) -> int:
    if len(args) != 1:
        _die("validate takes: <receipt>")
    violations = validate(args[0])
    for v in violations:
        print(v)
    return 1 if violations else 0


def _cmd_validate_dir(args: list[str]) -> int:
    if len(args) != 1:
        _die("validate-dir takes: <receipts_dir>")
    violations = validate_dir(args[0])
    for v in violations:
        print(v)
    return 1 if violations else 0


def _cmd_find_by_steer_key(args: list[str]) -> int:
    if len(args) != 2:
        _die("find-by-steer-key takes: <receipts_dir> <key>")
    hits = find_by_steer_key(parse_all(args[0]), args[1])
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
        _die("existing-keys takes: <receipts_dir>")
    for k in existing_keys(parse_all(args[0])):
        print(k)
    return 0


def _cmd_append_row(args: list[str]) -> int:
    if len(args) != 10:
        _die(
            "append-row takes: <receipt> <steer-key> <session> <issue> "
            "<type> <tier> <user-reason> <commit> <ordinal> <timestamp>"
        )
    receipt, steer_key, session, issue, typ, tier, reason, commit, ordinal, ts = args
    if typ not in VALID_TYPES:
        _die(f"unknown type {typ!r}")
    if tier not in VALID_TIERS:
        _die(f"unknown tier {tier!r}")
    if not _STEER_KEY_RE.match(steer_key):
        _die(f"malformed steer-key {steer_key!r}")
    if not _INT_RE.match(ordinal or "") or int(ordinal) < 1:
        _die(f"ordinal must be a positive integer (got {ordinal!r})")
    append_row(receipt, LedgerRow(
        steer_key=steer_key, session=session, issue=issue,
        type=typ, tier=tier, user_reason=reason, commit=commit,
        ordinal=int(ordinal), timestamp=ts,
    ))
    return 0


_COMMANDS = {
    "resolve-receipt": _cmd_resolve_receipt,
    "count-by-session": _cmd_count_by_session,
    "existing-ordinals": _cmd_existing_ordinals,
    "validate": _cmd_validate,
    "validate-dir": _cmd_validate_dir,
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
