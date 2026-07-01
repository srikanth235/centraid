#!/usr/bin/env python3
"""Read-only accounting report across per-issue receipts (issue #201).

Accounting rows moved out of the central COSTS.md / STEERING.md ledgers into
each issue's `receipts/issue-<N>.md` under a `## Accounting` section. That kept
the write path conflict-free, but cross-issue questions ("what did we spend in
total?", "which issues cost the most?") no longer have one file to read. This
script answers them by walking every receipt's `### Costs` / `### Steering`
sub-tables and aggregating — so nobody is tempted to reintroduce a central
ledger just to run a sum. (Issue #293 retired the commit-trailer copy of this
data, so the receipts are now the single queryable source.)

Stdlib-only. Reuses the cost-row parser from sibling `ledger.py`; parses the
steering sub-table inline (its parser lives in the other directive).

CLI:

    python3 report.py <receipts_dir> [--json]

        Default: a human-readable per-issue table plus grand totals.
        --json:  the same data as a JSON object, for piping into other tools.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.dont_write_bytecode = True  # don't litter the consumer repo with __pycache__

try:
    import receipt_io as rio  # type: ignore
    from ledger import parse_costs  # type: ignore
except ModuleNotFoundError:  # pragma: no cover
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import receipt_io as rio  # type: ignore
    from ledger import parse_costs  # type: ignore

_RECEIPT_RE = re.compile(r"^issue-([1-9][0-9]*)(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?\.md$")


def _steering_rows(path: Path) -> list[list[str]]:
    """Cell-lists for the receipt's `### Steering` sub-table data rows."""
    lines = path.read_text().splitlines()
    region = rio.subtable_region(lines, rio.STEERING_SUBHEADING)
    if region is None:
        return []
    out: list[list[str]] = []
    for idx in range(*region):
        cells = rio.parse_cells(lines[idx])
        if cells is None:
            continue
        if cells[0] in ("steer-key", "") or re.fullmatch(r"-+", cells[0] or ""):
            continue
        # 7 = legacy v1 steering row; 9 = v2 (+ ordinal, timestamp — issue #229).
        if len(cells) in (7, 9):
            out.append(cells)
    return out


def collect(receipts_dir: str | Path) -> dict:
    d = Path(receipts_dir)
    per_issue: dict[str, dict] = {}
    if d.is_dir():
        for f in sorted(d.glob("issue-*.md")):
            m = _RECEIPT_RE.match(f.name)
            if not m:
                continue
            issue = f"#{m.group(1)}"
            entry = per_issue.setdefault(
                issue,
                {"receipt": f.name, "commits": 0, "new_work": 0,
                 "cost_usd": 0.0, "steering": 0},
            )
            for row in parse_costs(f):
                entry["commits"] += 1
                entry["new_work"] += row.new_work
                if row.cost_usd is not None:
                    entry["cost_usd"] += row.cost_usd
            entry["steering"] += len(_steering_rows(f))

    totals = {
        "issues": len(per_issue),
        "commits": sum(e["commits"] for e in per_issue.values()),
        "new_work": sum(e["new_work"] for e in per_issue.values()),
        "cost_usd": round(sum(e["cost_usd"] for e in per_issue.values()), 4),
        "steering": sum(e["steering"] for e in per_issue.values()),
    }
    for e in per_issue.values():
        e["cost_usd"] = round(e["cost_usd"], 4)
    return {"per_issue": per_issue, "totals": totals}


def _issue_sort_key(issue: str) -> int:
    return int(issue.lstrip("#"))


def render_text(data: dict) -> str:
    per_issue = data["per_issue"]
    totals = data["totals"]
    lines = []
    header = f"{'issue':>7}  {'commits':>7}  {'new-work':>12}  {'cost-usd':>10}  {'steering':>8}"
    lines.append(header)
    lines.append("-" * len(header))
    for issue in sorted(per_issue, key=_issue_sort_key):
        e = per_issue[issue]
        lines.append(
            f"{issue:>7}  {e['commits']:>7}  {e['new_work']:>12,}  "
            f"{e['cost_usd']:>10.4f}  {e['steering']:>8}"
        )
    lines.append("-" * len(header))
    lines.append(
        f"{'TOTAL':>7}  {totals['commits']:>7}  {totals['new_work']:>12,}  "
        f"{totals['cost_usd']:>10.4f}  {totals['steering']:>8}"
    )
    lines.append("")
    lines.append(
        f"{totals['issues']} issue(s), {totals['commits']} accounted commit(s), "
        f"${totals['cost_usd']:.4f} total."
    )
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    args = [a for a in argv if not a.startswith("--")]
    as_json = "--json" in argv
    if len(args) != 1 or argv[:1] in (["-h"], ["--help"]):
        print("report.py <receipts_dir> [--json]", file=sys.stderr)
        return 2
    data = collect(args[0])
    if as_json:
        print(json.dumps(data, indent=2, sort_keys=True))
    else:
        print(render_text(data))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
