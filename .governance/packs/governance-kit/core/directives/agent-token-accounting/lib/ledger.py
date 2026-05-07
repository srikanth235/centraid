#!/usr/bin/env python3
"""Agent token accounting ledger — parse, sum, append, validate COSTS.md rows.

This module is the data-processing half of agent-token-accounting. The bash
hooks and directive scripts still do git plumbing and env detection; anything that
manipulates COSTS.md rows by name rather than by column index lives here.

Schema (v3 — model + cost-usd + new-work):

    | cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | note |

Where `new-work = input + cache_create + output` (cache_read tracked but
excluded — same bytes re-read, not new effort) and matches trailer
`Token-Total` by construction. `cost-usd` = `rates.lookup(model)` applied
to all four token columns; required on v3 rows with a non-empty `model`.

Legacy rows (v2: 10 cols, pre-model/cost-usd; v1: 8 cols, pre-cache-split)
and v3 rows predating the cost-mandate (empty `model`) are grandfathered:
parser accepts them and validator exempts them from the cost requirement.

This module is stdlib-only and depends only on `rates.py` in the same dir.

CLI shims (called from bash):

    python3 -m ledger sum-by-session <ledger> <session_id>
        → prints  "<input> <cache_create> <cache_read> <output>"

    python3 -m ledger append-row <ledger> <cost_key> <agent> <session> \\
                                 <issue> <model> \\
                                 <input> <cache_create> <cache_read> \\
                                 <output> <note>
        → appends the row (recomputes new_work, looks up cost_usd).

    python3 -m ledger validate <ledger>
        → prints one violation per line; exits non-zero if any.

    python3 -m ledger find-by-cost-key <ledger> <cost_key>
        → prints "<input> <cache_create> <cache_read> <output> <new_work> <cost_usd>"
          where cost_usd is a 4-decimal float or the literal string "-"
          (unpriced / legacy row). Exits 2 on miss. The bash caller passes
          cost_usd through to trailers.py for the Cost-USD cross-check.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from pathlib import Path

# rates.py sits next to this file; import relative works under `python3 ledger.py …`
# because the parent dir is on sys.path.
try:
    from rates import compute_cost_usd  # type: ignore
except ModuleNotFoundError:  # pragma: no cover — import fallback when run as a module
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from rates import compute_cost_usd  # type: ignore


# ── Schema ────────────────────────────────────────────────────────────────

COLUMNS = (
    "cost_key",
    "agent",
    "session",
    "issue",
    "model",
    "input",
    "cache_create",
    "cache_read",
    "output",
    "new_work",
    "cost_usd",
    "note",
)

NUMERIC_COLUMNS = ("input", "cache_create", "cache_read", "output")

LEDGER_TEMPLATE = """\
<!-- COSTS.md — append-only agent token-accounting ledger -->
<!-- governance: allow-plan-captured -->

# COSTS.md

Append-only ledger of token consumption for agent-authored commits. Rows are
keyed by `Cost-Key`, which is mirrored into the commit trailers so the ledger
survives squash merges that strip the original commit history.

**Do not** rewrite or reorder rows. This file is the durable system-of-record
that the `agent-token-accounting` governance directive validates.

## Ledger

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
"""


# ── Row model ─────────────────────────────────────────────────────────────


@dataclass
class LedgerRow:
    cost_key: str = ""
    agent: str = ""
    session: str = ""
    issue: str = ""
    model: str = ""
    input: int = 0
    cache_create: int = 0
    cache_read: int = 0
    output: int = 0
    new_work: int = 0
    cost_usd: float | None = None  # None = unknown model (empty cell in ledger)
    note: str = ""

    @property
    def expected_new_work(self) -> int:
        # new_work = input + cache_create + output.  cache_read is tracked
        # but excluded — it's re-reads of the same bytes, not new effort.
        return self.input + self.cache_create + self.output

    def to_cells(self) -> list[str]:
        cost_cell = "" if self.cost_usd is None else f"{self.cost_usd:.4f}"
        return [
            self.cost_key,
            self.agent,
            self.session,
            self.issue,
            self.model,
            str(self.input),
            str(self.cache_create),
            str(self.cache_read),
            str(self.output),
            str(self.new_work),
            cost_cell,
            self.note,
        ]


# ── Parse ─────────────────────────────────────────────────────────────────


_INT_RE = re.compile(r"^-?\d+$")
_FLOAT_RE = re.compile(r"^-?\d+(\.\d+)?$")
_ISSUE_RE = re.compile(r"^#[1-9][0-9]*$")


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
    if first == "cost-key":
        return True
    if first == "" or re.fullmatch(r"-+", first or ""):
        return True
    if all(c == "" or re.fullmatch(r"-+", c) for c in cells):
        return True
    return False


def _to_int(s: str) -> int:
    return int(s) if _INT_RE.match(s or "") else 0


def _to_cost(s: str) -> float | None:
    s = (s or "").strip()
    if not s:
        return None
    return float(s) if _FLOAT_RE.match(s) else None


def parse(path: str | Path) -> list[LedgerRow]:
    """Parse all data rows. Accepts v1 (8), v2 (10), and v3 (12) shapes.

    For v1/v2 rows, `model` and `cost_usd` are left empty. The old `total`
    column value is stored as `new_work` (identical semantic since the
    2026-04-23 directive tightening dropped cache_read from total).
    """
    p = Path(path)
    if not p.is_file():
        return []
    rows: list[LedgerRow] = []
    for line in p.read_text().splitlines():
        cells = _parse_cells(line)
        if cells is None or _is_header_or_separator(cells):
            continue

        if len(cells) == 12:
            (cost_key, agent, session, issue, model, i, cc, cr, o, nw, cost, note) = cells
            rows.append(
                LedgerRow(
                    cost_key=cost_key,
                    agent=agent,
                    session=session,
                    issue=issue,
                    model=model,
                    input=_to_int(i),
                    cache_create=_to_int(cc),
                    cache_read=_to_int(cr),
                    output=_to_int(o),
                    new_work=_to_int(nw),
                    cost_usd=_to_cost(cost),
                    note=note,
                )
            )
        elif len(cells) == 10:
            (cost_key, agent, session, issue, i, cc, cr, o, t, note) = cells
            rows.append(
                LedgerRow(
                    cost_key=cost_key,
                    agent=agent,
                    session=session,
                    issue=issue,
                    input=_to_int(i),
                    cache_create=_to_int(cc),
                    cache_read=_to_int(cr),
                    output=_to_int(o),
                    new_work=_to_int(t),  # v2 `total` == v3 `new_work`
                    note=note,
                )
            )
        elif len(cells) == 8:
            (cost_key, agent, session, issue, i, o, t, note) = cells
            rows.append(
                LedgerRow(
                    cost_key=cost_key,
                    agent=agent,
                    session=session,
                    issue=issue,
                    input=_to_int(i),
                    output=_to_int(o),
                    new_work=_to_int(t),
                    note=note,
                )
            )
        else:
            continue
    return rows


# ── Queries ───────────────────────────────────────────────────────────────


def sum_by_session(rows: list[LedgerRow], session_id: str) -> LedgerRow:
    """Return a synthetic LedgerRow summing numeric fields across all rows
    matching `session_id`. Used to compute per-commit delta."""
    agg = LedgerRow(session=session_id)
    for r in rows:
        if r.session == session_id:
            agg.input += r.input
            agg.cache_create += r.cache_create
            agg.cache_read += r.cache_read
            agg.output += r.output
    agg.new_work = agg.expected_new_work
    return agg


def find_by_cost_key(rows: list[LedgerRow], cost_key: str) -> list[LedgerRow]:
    return [r for r in rows if r.cost_key == cost_key]


# ── Append ────────────────────────────────────────────────────────────────


def append_row(path: str | Path, row: LedgerRow) -> None:
    """Append `row` to the ledger. Creates the file if needed. Recomputes
    `new_work` and looks up `cost_usd` from `row.model`."""
    row.new_work = row.expected_new_work
    if row.cost_usd is None:
        row.cost_usd = compute_cost_usd(
            row.model, row.input, row.cache_create, row.cache_read, row.output
        )
    p = Path(path)
    if not p.exists():
        p.write_text(LEDGER_TEMPLATE)
    cells = row.to_cells()
    cells[-1] = _safe_cell(cells[-1])[:80]
    line = "| " + " | ".join(cells) + " |\n"
    with p.open("a") as f:
        f.write(line)


def _safe_cell(s: str) -> str:
    cleaned = "".join(ch for ch in s if ch.isprintable() and ch != "|")
    if "\\" in cleaned:
        cleaned = cleaned.split("\\", 1)[0]
    return cleaned.strip()


# ── Validate ──────────────────────────────────────────────────────────────


def validate(path: str | Path) -> list[str]:
    """Walk the ledger, return violation strings.

    Checks:
        - Every data row has 8 (v1), 10 (v2), or 12 (v3) cells.
        - Token columns are non-negative integers.
        - new_work == input + cache_create + output.
        - cost_usd is a non-negative float; required on v3 rows whose
          `model` cell is non-empty. Grandfathered to empty on v1/v2
          rows and on v3 rows predating the cost-mandate (empty model).
        - issue matches `#N`; agent/session/issue non-empty.
        - cost-key unique across the file.
    """
    p = Path(path)
    if not p.is_file():
        return []

    violations: list[str] = []
    cost_keys: dict[str, int] = {}

    for line_no, line in enumerate(p.read_text().splitlines(), start=1):
        cells = _parse_cells(line)
        if cells is None or _is_header_or_separator(cells):
            continue
        if len(cells) not in (8, 10, 12):
            violations.append(
                f"COSTS.md:{line_no} — row has {len(cells)} cells, expected 8/10/12"
            )
            continue

        model = ""
        if len(cells) == 12:
            cost_key, agent, session, issue, model, i, cc, cr, o, nw, cost, _note = cells
        elif len(cells) == 10:
            cost_key, agent, session, issue, i, cc, cr, o, nw, _note = cells
            cost = ""
        else:  # 8
            cost_key, agent, session, issue, i, o, nw, _note = cells
            cc, cr, cost = "0", "0", ""

        if not cost_key:
            violations.append(f"COSTS.md:{line_no} — empty cost-key")
            continue
        if not agent or not session or not issue:
            violations.append(
                f"COSTS.md — row '{cost_key}' has empty agent/session/issue field"
            )
        if issue and not _ISSUE_RE.match(issue):
            violations.append(
                f"COSTS.md — row '{cost_key}' issue '{issue}' must look like '#123'"
            )

        token_cells = {"input": i, "cache_create": cc, "cache_read": cr, "output": o, "new_work": nw}
        if not all(_INT_RE.match(v or "") and int(v) >= 0 for v in token_cells.values()):
            violations.append(
                f"COSTS.md — row '{cost_key}' has non-integer or negative token counts "
                f"(input={i}, cache_create={cc}, cache_read={cr}, output={o}, new_work={nw})"
            )
            continue

        expected_nw = int(i) + int(cc) + int(o)
        if int(nw) != expected_nw:
            violations.append(
                f"COSTS.md — row '{cost_key}' has new_work={nw} but "
                f"input+cache_create+output={expected_nw} "
                f"(cache_read={cr} is tracked but excluded from new_work)"
            )

        if cost and not _FLOAT_RE.match(cost):
            violations.append(
                f"COSTS.md — row '{cost_key}' has non-numeric cost_usd '{cost}'"
            )
        elif cost and float(cost) < 0:
            violations.append(
                f"COSTS.md — row '{cost_key}' has negative cost_usd '{cost}'"
            )
        elif not cost and len(cells) == 12 and model:
            # v3 row with a model but no cost_usd — this shape is only
            # legal before the cost-mandate landed (empty model column).
            # A row with `model` set but `cost_usd` empty is a stamping
            # bug, not a grandfathered legacy row.
            violations.append(
                f"COSTS.md — row '{cost_key}' names model '{model}' but "
                f"has empty cost_usd (add a matching entry to lib/rates.py "
                f"or backfill the cell)"
            )

        cost_keys[cost_key] = cost_keys.get(cost_key, 0) + 1

    for key, count in cost_keys.items():
        if count > 1:
            violations.append(
                f"COSTS.md — cost-key '{key}' appears {count} times (must be unique, append-only)"
            )

    return violations


# ── CLI ───────────────────────────────────────────────────────────────────


def _cmd_sum_by_session(args: list[str]) -> int:
    if len(args) != 2:
        _die("sum-by-session takes: <ledger> <session_id>")
    rows = parse(args[0])
    agg = sum_by_session(rows, args[1])
    print(f"{agg.input} {agg.cache_create} {agg.cache_read} {agg.output}")
    return 0


def _cmd_append_row(args: list[str]) -> int:
    # ledger cost_key agent session issue model input cache_create cache_read output note
    if len(args) != 11:
        _die(
            "append-row takes: <ledger> <cost_key> <agent> <session> <issue> "
            "<model> <input> <cache_create> <cache_read> <output> <note>"
        )
    (
        ledger, cost_key, agent, session, issue, model,
        inp, cc, cr, out, note,
    ) = args

    def to_int(s: str, label: str) -> int:
        if not _INT_RE.match(s) or int(s) < 0:
            _die(f"{label} must be a non-negative integer (got {s!r})")
        return int(s)

    row = LedgerRow(
        cost_key=cost_key,
        agent=agent,
        session=session,
        issue=issue,
        model=model,
        input=to_int(inp, "input"),
        cache_create=to_int(cc, "cache_create"),
        cache_read=to_int(cr, "cache_read"),
        output=to_int(out, "output"),
        note=note,
    )
    append_row(ledger, row)
    return 0


def _cmd_validate(args: list[str]) -> int:
    if len(args) != 1:
        _die("validate takes: <ledger>")
    violations = validate(args[0])
    for v in violations:
        print(v)
    return 1 if violations else 0


def _cmd_find_by_cost_key(args: list[str]) -> int:
    if len(args) != 2:
        _die("find-by-cost-key takes: <ledger> <cost_key>")
    rows = parse(args[0])
    hits = find_by_cost_key(rows, args[1])
    if len(hits) != 1:
        print(f"expected 1 row for cost-key '{args[1]}', found {len(hits)}", file=sys.stderr)
        return 2
    r = hits[0]
    cost = "-" if r.cost_usd is None else f"{r.cost_usd:.4f}"
    print(f"{r.input} {r.cache_create} {r.cache_read} {r.output} {r.new_work} {cost}")
    return 0


def _die(msg: str) -> None:
    print(f"ledger: {msg}", file=sys.stderr)
    sys.exit(2)


_COMMANDS = {
    "sum-by-session": _cmd_sum_by_session,
    "append-row": _cmd_append_row,
    "validate": _cmd_validate,
    "find-by-cost-key": _cmd_find_by_cost_key,
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
