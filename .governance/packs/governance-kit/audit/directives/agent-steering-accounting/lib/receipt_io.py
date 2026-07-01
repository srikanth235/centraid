#!/usr/bin/env python3
"""Markdown section / table primitives for receipt-homed accounting (issue #201).

Accounting rows live under a receipt's `## Accounting` section as `### Costs`
and `### Steering` sub-tables. This module knows how to find that region, parse
a pipe-table's data rows, and splice a new row into the tail of a sub-table —
creating the section / sub-table / file when absent. The cost-specific schema
lives in `ledger.py`; the generic Markdown plumbing lives here so the row-logic
module stays focused.

Stdlib-only, shared by `ledger.py` and `report.py` in this directory.
"""

from __future__ import annotations

import re
from pathlib import Path

ACCOUNTING_HEADING = "## Accounting"
COSTS_SUBHEADING = "### Costs"
STEERING_SUBHEADING = "### Steering"
ACCOUNTING_NOTE = (
    "<!-- Accounting rows are maintained by the agent-token-accounting and "
    "agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->"
)


def parse_cells(line: str) -> list[str] | None:
    stripped = line.strip()
    if not stripped.startswith("|"):
        return None
    parts = [c.strip() for c in stripped.split("|")[1:-1]]
    return parts or None


def is_header_or_separator(cells: list[str], header_first_cell: str) -> bool:
    if not cells:
        return True
    first = cells[0]
    if first == header_first_cell:
        return True
    if first == "" or re.fullmatch(r"-+", first or ""):
        return True
    if all(c == "" or re.fullmatch(r"-+", c) for c in cells):
        return True
    return False


def find_heading(lines: list[str], heading: str, start: int = 0, end: int | None = None) -> int:
    end = len(lines) if end is None else end
    for i in range(start, end):
        if lines[i].strip() == heading:
            return i
    return -1


def section_end(lines: list[str], heading_idx: int) -> int:
    """Index (exclusive) where the section opened at `heading_idx` ends — the
    next `# ` or `## ` heading, or EOF. `### ` sub-headings stay inside."""
    j = heading_idx + 1
    while j < len(lines):
        s = lines[j]
        if s.startswith("## ") or (s.startswith("# ") and not s.startswith("## ")):
            break
        j += 1
    return j


def subsection_end(lines: list[str], sub_idx: int, sec_end: int) -> int:
    """Index (exclusive) where the `### ` sub-table opened at `sub_idx` ends."""
    j = sub_idx + 1
    while j < sec_end:
        s = lines[j]
        if s.startswith("### ") or s.startswith("## ") or (
            s.startswith("# ") and not s.startswith("## ")
        ):
            break
        j += 1
    return j


def subtable_region(lines: list[str], subheading: str) -> tuple[int, int] | None:
    """(start, end) line indices spanning `subheading`'s data rows within
    `## Accounting`, or None if the section / sub-table is absent."""
    acc = find_heading(lines, ACCOUNTING_HEADING)
    if acc == -1:
        return None
    sec_end = section_end(lines, acc)
    sub = find_heading(lines, subheading, acc + 1, sec_end)
    if sub == -1:
        return None
    return sub + 1, subsection_end(lines, sub, sec_end)


def _ensure_accounting(lines: list[str]) -> int:
    idx = find_heading(lines, ACCOUNTING_HEADING)
    if idx != -1:
        return idx
    if lines and lines[-1].strip() != "":
        lines.append("")
    lines.append(ACCOUNTING_HEADING)
    lines.append("")
    lines.append(ACCOUNTING_NOTE)
    lines.append("")
    return len(lines) - 4


def insert_table_row(
    text: str, subheading: str, header: str, separator: str, row_line: str
) -> str:
    """Insert `row_line` at the tail of `subheading`'s table under
    `## Accounting`, creating the section / sub-table / file as needed."""
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()

    acc_idx = _ensure_accounting(lines)
    sec_end = section_end(lines, acc_idx)
    sub_idx = find_heading(lines, subheading, acc_idx + 1, sec_end)

    if sub_idx == -1:
        block: list[str] = []
        if sec_end > 0 and lines[sec_end - 1].strip() != "":
            block.append("")
        block += [subheading, "", header, separator, row_line]
        lines[sec_end:sec_end] = block
    else:
        i = sub_idx + 1
        while i < sec_end and lines[i].strip() == "":
            i += 1
        while i < sec_end and lines[i].lstrip().startswith("|"):
            i += 1
        lines.insert(i, row_line)

    return "\n".join(lines) + "\n"


def write_row(path: str | Path, subheading: str, header: str, separator: str, row_line: str) -> None:
    p = Path(path)
    text = p.read_text() if p.exists() else ""
    p.write_text(insert_table_row(text, subheading, header, separator, row_line))
