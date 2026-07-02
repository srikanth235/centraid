#!/usr/bin/env python3
"""Cost-row validation for agent-token-accounting.

Split out of `ledger.py` so each module stays focused (and under the
repo-hygiene file-size limit): `ledger.py` owns schema / parse / append /
queries; this module owns receipt validation — per-row shape (v3 legacy + v4),
global cost-key uniqueness, and the cross-session cumulative reconciliation +
monotonicity (delegated to `reconcile.py`).

`ledger.py` lazy-imports `validate` / `validate_dir` from here in its CLI, so
the dependency stays one-directional (validate → ledger, not the reverse) with
no import cycle. Stdlib-only.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.dont_write_bytecode = True

try:
    import receipt_io as rio
    from ledger import (
        V3_COLS, V4_COLS, _ISSUE_RE, _INT_RE, _FLOAT_RE,
        _issue_from_name, parse_costs, parse_all_costs,
    )
    from reconcile import reconcile_sessions
except ModuleNotFoundError:  # pragma: no cover
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import receipt_io as rio
    from ledger import (
        V3_COLS, V4_COLS, _ISSUE_RE, _INT_RE, _FLOAT_RE,
        _issue_from_name, parse_costs, parse_all_costs,
    )
    from reconcile import reconcile_sessions


def _validate_row_cells(
    cells: list[str], line_no: int, name: str, issue_n: str | None
) -> tuple[list[str], str | None]:
    violations: list[str] = []
    if len(cells) == V4_COLS:
        (cost_key, agent, session, issue, model, i, cc, cr, o, nw, cost,
         ci, ccc, ccr, co, _note) = cells
        cum_cells: dict[str, str] | None = {
            "cum_input": ci, "cum_cache_create": ccc,
            "cum_cache_read": ccr, "cum_output": co,
        }
    elif len(cells) == V3_COLS:
        (cost_key, agent, session, issue, model, i, cc, cr, o, nw, cost, _note) = cells
        cum_cells = None
    else:
        violations.append(
            f"{name}:{line_no} — row has {len(cells)} cells, expected "
            f"{V3_COLS} (legacy) or {V4_COLS}"
        )
        return violations, None

    if not cost_key:
        violations.append(f"{name}:{line_no} — empty cost-key")
        return violations, None
    if not agent or not session or not issue:
        violations.append(f"{name} — row '{cost_key}' has empty agent/session/issue field")
    if issue and not _ISSUE_RE.match(issue):
        violations.append(f"{name} — row '{cost_key}' issue '{issue}' must look like '#123'")
    elif issue and issue_n is not None and issue != issue_n:
        violations.append(
            f"{name} — row '{cost_key}' issue '{issue}' does not match this receipt's "
            f"issue '{issue_n}' (a cost row lives in the receipt for its own issue)"
        )

    token_cells = {"input": i, "cache_create": cc, "cache_read": cr, "output": o, "new_work": nw}
    if not all(_INT_RE.match(v or "") and int(v) >= 0 for v in token_cells.values()):
        violations.append(
            f"{name} — row '{cost_key}' has non-integer or negative token counts "
            f"(input={i}, cache_create={cc}, cache_read={cr}, output={o}, new_work={nw})"
        )
        return violations, cost_key

    expected_nw = int(i) + int(cc) + int(o)
    if int(nw) != expected_nw:
        violations.append(
            f"{name} — row '{cost_key}' has new_work={nw} but "
            f"input+cache_create+output={expected_nw} "
            f"(cache_read={cr} is tracked but excluded from new_work)"
        )

    if cost and not _FLOAT_RE.match(cost):
        violations.append(f"{name} — row '{cost_key}' has non-numeric cost_usd '{cost}'")
    elif cost and float(cost) < 0:
        violations.append(f"{name} — row '{cost_key}' has negative cost_usd '{cost}'")
    elif not cost and model:
        violations.append(
            f"{name} — row '{cost_key}' names model '{model}' but has empty cost_usd "
            f"(add a `rate {model} ...` row to "
            f".governance/conf/governance-kit/audit/agent-token-accounting.conf or backfill the cell)"
        )

    # v4 cumulative columns: non-negative integers, each ≥ its own delta (the
    # cumulative includes this commit's contribution).
    if cum_cells is not None:
        if not all(_INT_RE.match(v or "") and int(v) >= 0 for v in cum_cells.values()):
            violations.append(
                f"{name} — row '{cost_key}' has non-integer or negative cumulative "
                f"counts (cum_input={ci}, cum_cache_create={ccc}, "
                f"cum_cache_read={ccr}, cum_output={co})"
            )
        else:
            for cum_val, delta_val, label in (
                (ci, i, "input"), (ccc, cc, "cache_create"),
                (ccr, cr, "cache_read"), (co, o, "output"),
            ):
                if int(cum_val) < int(delta_val):
                    violations.append(
                        f"{name} — row '{cost_key}' cum_{label} ({cum_val}) is less "
                        f"than its {label} delta ({delta_val}) — a cumulative counter "
                        f"cannot be smaller than the slice it contains"
                    )

    return violations, cost_key


def validate(path: str | Path) -> list[str]:
    """Validate one receipt's `### Costs` sub-table."""
    p = Path(path)
    if not p.is_file():
        return []
    name = p.name
    lines = p.read_text().splitlines()
    region = rio.subtable_region(lines, rio.COSTS_SUBHEADING)
    if region is None:
        return []
    issue_n = _issue_from_name(name)

    violations: list[str] = []
    cost_keys: dict[str, int] = {}
    for idx in range(*region):
        cells = rio.parse_cells(lines[idx])
        if cells is None or rio.is_header_or_separator(cells, "cost-key"):
            continue
        v, key = _validate_row_cells(cells, idx + 1, name, issue_n)
        violations.extend(v)
        if key:
            cost_keys[key] = cost_keys.get(key, 0) + 1

    for key, count in cost_keys.items():
        if count > 1:
            violations.append(f"{name} — cost-key '{key}' appears {count} times (must be unique)")
    return violations


def validate_dir(receipts_dir: str | Path) -> list[str]:
    """Validate every receipt's Costs sub-table plus global cost-key uniqueness
    and cross-receipt cumulative reconciliation (issue #229)."""
    d = Path(receipts_dir)
    if not d.is_dir():
        return []
    violations: list[str] = []
    seen: dict[str, str] = {}
    for f in sorted(d.glob("issue-*.md")):
        violations.extend(validate(f))
        for row in parse_costs(f):
            if not row.cost_key:
                continue
            if row.cost_key in seen and seen[row.cost_key] != f.name:
                violations.append(
                    f"receipts — cost-key '{row.cost_key}' appears in both "
                    f"{seen[row.cost_key]} and {f.name} (must be globally unique)"
                )
            else:
                seen.setdefault(row.cost_key, f.name)

    violations.extend(reconcile_sessions(parse_all_costs(d)))
    return violations
