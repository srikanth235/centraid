#!/usr/bin/env python3
"""Agent token accounting — parse, sum, append, validate cost rows.

Cost rows live in per-issue receipts (issue #201): each row is appended under
the `## Accounting` → `### Costs` sub-table of `receipts/issue-<N>.md`, not in a
central `COSTS.md`. The receipt is conflict-free (only its own PR branch writes
it) and naturally sealed (frozen on the trunk by doc-integrity). `COSTS.md` is
sealed history this flow no longer reads or writes.

Row schema — v4 (16 columns, issue #229):

    | cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |

The four `cum-*` columns are the row's **absolute transcript coordinates** —
the session's cumulative input / cache-create / cache-read / output counters at
the moment this commit was made, written blind from the transcript. They are
the accounting source of truth: a row doesn't *claim* tokens, it claims a
position on a monotonic counter, so double-counting across branches is
structurally impossible. The delta columns (`input`/`cache-create`/`cache-read`/
`output`/`new-work`/`cost-usd`) are **derived claims** for display / trailers,
computed at commit time from a per-session checkpoint; where a session's
consecutive rows are co-visible the validator proves `delta == cum(n) −
cum(n−1)`, otherwise it skips that pair (it never blocks on an absent
predecessor).

`new-work = input + cache_create + output` (cache_read tracked but excluded —
same bytes re-read, not new effort) and matches trailer `Token-Total` by
construction. `cost-usd` = `rates.lookup(model)` over all four token columns;
required when `model` is non-empty. `cost-key` is opaque
(`<agent>-<session-short>-<epoch>-<n>`) — a join token, not a parseable id.

Legacy v3 rows (12 columns, no `cum-*`) keep parsing and are validated to the
v3 rules; they are excluded from cumulative reconciliation / monotonicity (those
apply to v4 rows only).

Markdown section/table plumbing lives in sibling `receipt_io.py`; pricing in
`rates.py`. Stdlib-only. CLI shims (called from the bash hook / check):

    resolve-receipt <receipts_dir> <issue>    → receipt path for issue N
    sum-by-session  <receipts_dir> <session>  → "<in> <cc> <cr> <out>" summed
                                                 (query helper; NOT on the write
                                                  path — issue #229)
    checkpoint-get  <file> <session>          → "<ci> <ccc> <ccr> <co>" (0s if absent)
    checkpoint-set  <file> <session> <ci> <ccc> <ccr> <co>
    next-cost-index <receipts_dir> <prefix>   → 1 + (#rows with that key prefix)
    append-row      <receipt> <cost_key> <agent> <session> <issue> <model> \\
                    <input> <cache_create> <cache_read> <output> \\
                    <cum_input> <cum_cache_create> <cum_cache_read> <cum_output> <note>
    validate        <receipt>                 → one violation per line
    validate-dir    <receipts_dir>            → all receipts + global uniqueness
                                                 + cumulative reconciliation/monotonicity
    find-by-cost-key <receipts_dir> <key>     → "<in> <cc> <cr> <out> <nw> <usd>"
    session-cum     <receipts_dir> <session>  → "<cum_in> <cum_cc> <cum_cr> <cum_out>"
                                                 (query helper for the latest
                                                  recorded receipt coordinate)
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
    from rates import compute_cost_usd  # type: ignore
    import receipt_io as rio  # type: ignore
    from reconcile import checkpoint_get, checkpoint_set  # type: ignore
except ModuleNotFoundError:  # pragma: no cover — import fallback when run as a module
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from rates import compute_cost_usd  # type: ignore
    import receipt_io as rio  # type: ignore
    from reconcile import checkpoint_get, checkpoint_set  # type: ignore


COLUMNS = (
    "cost_key", "agent", "session", "issue", "model", "input",
    "cache_create", "cache_read", "output", "new_work", "cost_usd",
    "cum_input", "cum_cache_create", "cum_cache_read", "cum_output", "note",
)
NUMERIC_COLUMNS = ("input", "cache_create", "cache_read", "output")
CUM_COLUMNS = ("cum_input", "cum_cache_create", "cum_cache_read", "cum_output")

COST_HEADER = (
    "| cost-key | agent | session | issue | model | input | cache-create "
    "| cache-read | output | new-work | cost-usd "
    "| cum-input | cum-cache-create | cum-cache-read | cum-output | note |"
)
COST_SEPARATOR = (
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- "
    "| --- | --- | --- | --- | --- |"
)

# v4 adds the four cumulative columns; v3 is the 12-column predecessor.
V4_COLS = 16
V3_COLS = 12

_INT_RE = re.compile(r"^-?\d+$")
_FLOAT_RE = re.compile(r"^-?\d+(\.\d+)?$")
_ISSUE_RE = re.compile(r"^#[1-9][0-9]*$")
_RECEIPT_NAME_RE = re.compile(r"^issue-([1-9][0-9]*)(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?\.md$")


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
    cost_usd: float | None = None
    # v4 cumulative coordinates — None on legacy v3 rows.
    cum_input: int | None = None
    cum_cache_create: int | None = None
    cum_cache_read: int | None = None
    cum_output: int | None = None
    note: str = ""

    @property
    def expected_new_work(self) -> int:
        return self.input + self.cache_create + self.output

    @property
    def has_cum(self) -> bool:
        return None not in (
            self.cum_input, self.cum_cache_create,
            self.cum_cache_read, self.cum_output,
        )

    @property
    def cum_total(self) -> int | None:
        if not self.has_cum:
            return None
        return (
            self.cum_input + self.cum_cache_create
            + self.cum_cache_read + self.cum_output
        )

    @property
    def delta_total(self) -> int:
        """Sum of the four per-commit token deltas (parallels `cum_total`)."""
        return self.input + self.cache_create + self.cache_read + self.output

    def to_cells(self) -> list[str]:
        cost_cell = "" if self.cost_usd is None else f"{self.cost_usd:.4f}"

        def _cum(v: int | None) -> str:
            return "" if v is None else str(v)

        return [
            self.cost_key, self.agent, self.session, self.issue, self.model,
            str(self.input), str(self.cache_create), str(self.cache_read),
            str(self.output), str(self.new_work), cost_cell,
            _cum(self.cum_input), _cum(self.cum_cache_create),
            _cum(self.cum_cache_read), _cum(self.cum_output),
            self.note,
        ]


# ── Parse ─────────────────────────────────────────────────────────────────


def _to_int(s: str) -> int:
    return int(s) if _INT_RE.match(s or "") else 0


def _to_int_or_none(s: str) -> int | None:
    s = (s or "").strip()
    if not s:
        return None
    return int(s) if _INT_RE.match(s) else None


def _to_cost(s: str) -> float | None:
    s = (s or "").strip()
    if not s:
        return None
    return float(s) if _FLOAT_RE.match(s) else None


def _issue_from_name(name: str) -> str | None:
    m = _RECEIPT_NAME_RE.match(name)
    return f"#{m.group(1)}" if m else None


def _row_from_cells(cells: list[str]) -> LedgerRow | None:
    if len(cells) == V4_COLS:
        (cost_key, agent, session, issue, model, i, cc, cr, o, nw, cost,
         ci, ccc, ccr, co, note) = cells
        return LedgerRow(
            cost_key=cost_key, agent=agent, session=session, issue=issue, model=model,
            input=_to_int(i), cache_create=_to_int(cc), cache_read=_to_int(cr),
            output=_to_int(o), new_work=_to_int(nw), cost_usd=_to_cost(cost),
            cum_input=_to_int_or_none(ci), cum_cache_create=_to_int_or_none(ccc),
            cum_cache_read=_to_int_or_none(ccr), cum_output=_to_int_or_none(co),
            note=note,
        )
    if len(cells) == V3_COLS:
        (cost_key, agent, session, issue, model, i, cc, cr, o, nw, cost, note) = cells
        return LedgerRow(
            cost_key=cost_key, agent=agent, session=session, issue=issue, model=model,
            input=_to_int(i), cache_create=_to_int(cc), cache_read=_to_int(cr),
            output=_to_int(o), new_work=_to_int(nw), cost_usd=_to_cost(cost), note=note,
        )
    return None


def parse_costs(path: str | Path) -> list[LedgerRow]:
    """Parse the cost rows from one receipt's `### Costs` sub-table."""
    p = Path(path)
    if not p.is_file():
        return []
    lines = p.read_text().splitlines()
    region = rio.subtable_region(lines, rio.COSTS_SUBHEADING)
    if region is None:
        return []
    rows: list[LedgerRow] = []
    for idx in range(*region):
        cells = rio.parse_cells(lines[idx])
        if cells is None or rio.is_header_or_separator(cells, "cost-key"):
            continue
        row = _row_from_cells(cells)
        if row is not None:
            rows.append(row)
    return rows


parse = parse_costs  # alias for callers importing `parse`


def parse_all_costs(receipts_dir: str | Path) -> list[LedgerRow]:
    d = Path(receipts_dir)
    rows: list[LedgerRow] = []
    if d.is_dir():
        for f in sorted(d.glob("issue-*.md")):
            rows.extend(parse_costs(f))
    return rows


# ── Queries ───────────────────────────────────────────────────────────────


def sum_by_session(rows: list[LedgerRow], session_id: str) -> LedgerRow:
    """Sum the delta columns across a session's rows.

    A query / validation helper only — issue #229 removed this from the write
    path (the write path now reads a per-session checkpoint of the absolute
    cumulative counters, never the receipts, so a row's tokens never depend on
    which sibling receipts happen to be visible in the current branch's tree).
    """
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


def session_cum(rows: list[LedgerRow], session: str) -> tuple[int, int, int, int]:
    """The session's recorded cumulative coordinate: the (cum_input,
    cum_cache_create, cum_cache_read, cum_output) of the v4 row with the
    greatest `cum_total` for `session`, or (0, 0, 0, 0) if the session has no
    v4 row.

    This is a query helper for the latest receipt-side coordinate. Commit-time
    endpoint reconciliation now verifies the staged row named by the frozen
    endpoint file; because rows store absolute coordinates (not deltas), the
    latest row's cumulative is still the whole session's recorded total."""
    best: LedgerRow | None = None
    for r in rows:
        if r.session != session or not r.has_cum:
            continue
        if best is None or r.cum_total > best.cum_total:  # type: ignore[operator]
            best = r
    if best is None:
        return (0, 0, 0, 0)
    return (
        best.cum_input or 0, best.cum_cache_create or 0,
        best.cum_cache_read or 0, best.cum_output or 0,
    )


def resolve_receipt(receipts_dir: str | Path, issue_number: str) -> str:
    """The receipt path a cost row for issue N belongs in: an existing
    `issue-N.md` / `issue-N-<slug>.md` (first, deterministically, if several),
    else the slugless `issue-N.md` create-if-absent default."""
    n = issue_number.lstrip("#")
    d = Path(receipts_dir)
    pat = re.compile(rf"^issue-{re.escape(n)}(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?\.md$")
    if d.is_dir():
        matches = sorted(p.name for p in d.iterdir() if p.is_file() and pat.match(p.name))
        if matches:
            return str(d / matches[0])
    return str(d / f"issue-{n}.md")


# Checkpoint helpers (`checkpoint_get`/`checkpoint_set`) and cumulative
# reconciliation (`reconcile_sessions`) live in sibling `reconcile.py`.


# ── Append ────────────────────────────────────────────────────────────────


def _safe_cell(s: str) -> str:
    cleaned = "".join(ch for ch in s if ch.isprintable() and ch != "|")
    if "\\" in cleaned:
        cleaned = cleaned.split("\\", 1)[0]
    return cleaned.strip()


def append_row(path: str | Path, row: LedgerRow) -> None:
    """Append `row` to <path>'s Costs sub-table. Recomputes `new_work` and
    looks up `cost_usd`; creates the receipt / section if needed. The four
    `cum-*` coordinates must already be set on `row` (issue #229)."""
    row.new_work = row.expected_new_work
    if row.cost_usd is None:
        row.cost_usd = compute_cost_usd(
            row.model, row.input, row.cache_create, row.cache_read, row.output
        )
    cells = row.to_cells()
    cells[-1] = _safe_cell(cells[-1])[:80]
    row_line = "| " + " | ".join(cells) + " |"
    rio.write_row(path, rio.COSTS_SUBHEADING, COST_HEADER, COST_SEPARATOR, row_line)


# Receipt validation (`validate`, `validate_dir`) lives in sibling
# `validate.py`; the CLI shims below lazy-import it to keep the dependency
# one-directional (validate → ledger).


# ── CLI ───────────────────────────────────────────────────────────────────


def _die(msg: str) -> None:
    print(f"ledger: {msg}", file=sys.stderr)
    sys.exit(2)


def _cmd_resolve_receipt(args: list[str]) -> int:
    if len(args) != 2:
        _die("resolve-receipt takes: <receipts_dir> <issue_number>")
    print(resolve_receipt(args[0], args[1]))
    return 0


def _cmd_sum_by_session(args: list[str]) -> int:
    if len(args) != 2:
        _die("sum-by-session takes: <receipts_dir> <session_id>")
    agg = sum_by_session(parse_all_costs(args[0]), args[1])
    print(f"{agg.input} {agg.cache_create} {agg.cache_read} {agg.output}")
    return 0


def _cmd_checkpoint_get(args: list[str]) -> int:
    if len(args) != 2:
        _die("checkpoint-get takes: <file> <session>")
    ci, ccc, ccr, co = checkpoint_get(args[0], args[1])
    print(f"{ci} {ccc} {ccr} {co}")
    return 0


def _cmd_checkpoint_set(args: list[str]) -> int:
    if len(args) != 6:
        _die("checkpoint-set takes: <file> <session> <ci> <ccc> <ccr> <co>")
    file, session = args[0], args[1]

    def to_int(s: str, label: str) -> int:
        if not _INT_RE.match(s) or int(s) < 0:
            _die(f"{label} must be a non-negative integer (got {s!r})")
        return int(s)

    checkpoint_set(
        file, session,
        to_int(args[2], "cum_input"), to_int(args[3], "cum_cache_create"),
        to_int(args[4], "cum_cache_read"), to_int(args[5], "cum_output"),
    )
    return 0


def _cmd_next_cost_index(args: list[str]) -> int:
    if len(args) != 2:
        _die("next-cost-index takes: <receipts_dir> <key_prefix>")
    rows = parse_all_costs(args[0])
    print(sum(1 for r in rows if r.cost_key.startswith(args[1])) + 1)
    return 0


def _cmd_append_row(args: list[str]) -> int:
    if len(args) != 15:
        _die(
            "append-row takes: <receipt> <cost_key> <agent> <session> <issue> "
            "<model> <input> <cache_create> <cache_read> <output> "
            "<cum_input> <cum_cache_create> <cum_cache_read> <cum_output> <note>"
        )
    (receipt, cost_key, agent, session, issue, model, inp, cc, cr, out,
     ci, ccc, ccr, co, note) = args

    def to_int(s: str, label: str) -> int:
        if not _INT_RE.match(s) or int(s) < 0:
            _die(f"{label} must be a non-negative integer (got {s!r})")
        return int(s)

    append_row(receipt, LedgerRow(
        cost_key=cost_key, agent=agent, session=session, issue=issue, model=model,
        input=to_int(inp, "input"), cache_create=to_int(cc, "cache_create"),
        cache_read=to_int(cr, "cache_read"), output=to_int(out, "output"),
        cum_input=to_int(ci, "cum_input"), cum_cache_create=to_int(ccc, "cum_cache_create"),
        cum_cache_read=to_int(ccr, "cum_cache_read"), cum_output=to_int(co, "cum_output"),
        note=note,
    ))
    return 0


def _cmd_validate(args: list[str]) -> int:
    if len(args) != 1:
        _die("validate takes: <receipt>")
    from validate import validate  # lazy — breaks the validate→ledger cycle
    violations = validate(args[0])
    for v in violations:
        print(v)
    return 1 if violations else 0


def _cmd_validate_dir(args: list[str]) -> int:
    if len(args) != 1:
        _die("validate-dir takes: <receipts_dir>")
    from validate import validate_dir  # lazy — breaks the validate→ledger cycle
    violations = validate_dir(args[0])
    for v in violations:
        print(v)
    return 1 if violations else 0


def _cmd_session_cum(args: list[str]) -> int:
    if len(args) != 2:
        _die("session-cum takes: <receipts_dir> <session>")
    ci, ccc, ccr, co = session_cum(parse_all_costs(args[0]), args[1])
    print(f"{ci} {ccc} {ccr} {co}")
    return 0


def _cmd_find_by_cost_key(args: list[str]) -> int:
    if len(args) != 2:
        _die("find-by-cost-key takes: <receipts_dir> <cost_key>")
    hits = find_by_cost_key(parse_all_costs(args[0]), args[1])
    if len(hits) != 1:
        print(f"expected 1 row for cost-key '{args[1]}', found {len(hits)}", file=sys.stderr)
        return 2
    r = hits[0]
    cost = "-" if r.cost_usd is None else f"{r.cost_usd:.4f}"
    print(f"{r.input} {r.cache_create} {r.cache_read} {r.output} {r.new_work} {cost}")
    return 0


_COMMANDS = {
    "resolve-receipt": _cmd_resolve_receipt,
    "sum-by-session": _cmd_sum_by_session,
    "checkpoint-get": _cmd_checkpoint_get,
    "checkpoint-set": _cmd_checkpoint_set,
    "next-cost-index": _cmd_next_cost_index,
    "append-row": _cmd_append_row,
    "validate": _cmd_validate,
    "validate-dir": _cmd_validate_dir,
    "find-by-cost-key": _cmd_find_by_cost_key,
    "session-cum": _cmd_session_cum,
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
