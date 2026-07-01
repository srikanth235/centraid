#!/usr/bin/env python3
"""Frozen endpoint files for agent-token-accounting (issue #305).

The pre-commit writer samples a runtime cumulative coordinate, appends the
receipt row, stages the receipt, then writes a git-dir endpoint keyed by the
staged tree id. The commit-msg checker recomputes that staged tree id and
verifies the receipt row against this frozen endpoint instead of re-reading a
moving live transcript coordinate.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True

try:
    from ledger import parse_costs  # type: ignore
except ModuleNotFoundError:  # pragma: no cover
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from ledger import parse_costs  # type: ignore


INT_FIELDS = ("input", "cache_create", "cache_read", "output")
STR_FIELDS = ("session", "receipt", "cost_key")


def _die(msg: str, rc: int = 2) -> None:
    print(f"endpoint: {msg}", file=sys.stderr)
    sys.exit(rc)


def _nonnegative_int(value: str, label: str) -> int:
    try:
        parsed = int(value)
    except ValueError:
        _die(f"{label} must be a non-negative integer (got {value!r})")
    if parsed < 0:
        _die(f"{label} must be a non-negative integer (got {value!r})")
    return parsed


def _load(path: str | Path) -> dict:
    p = Path(path)
    if not p.is_file():
        _die(f"missing frozen endpoint for staged tree: {p}", rc=3)
    try:
        data = json.loads(p.read_text())
    except Exception as exc:
        _die(f"could not parse frozen endpoint {p}: {exc}")
    if not isinstance(data, dict):
        _die(f"frozen endpoint {p} must contain a JSON object")

    for field in STR_FIELDS:
        if not isinstance(data.get(field), str) or not data[field]:
            _die(f"frozen endpoint {p} has missing/invalid {field!r}")
    for field in INT_FIELDS:
        if not isinstance(data.get(field), int) or data[field] < 0:
            _die(f"frozen endpoint {p} has missing/invalid {field!r}")
    return data


def _cmd_write(args: list[str]) -> int:
    if len(args) != 8:
        _die(
            "write takes: <endpoint-file> <session> <input> <cache_create> "
            "<cache_read> <output> <receipt-relpath> <cost_key>"
        )
    endpoint, session, ci, ccc, ccr, co, receipt, cost_key = args
    p = Path(endpoint)
    p.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "session": session,
        "input": _nonnegative_int(ci, "input"),
        "cache_create": _nonnegative_int(ccc, "cache_create"),
        "cache_read": _nonnegative_int(ccr, "cache_read"),
        "output": _nonnegative_int(co, "output"),
        "receipt": receipt,
        "cost_key": cost_key,
    }
    p.write_text(json.dumps(payload, sort_keys=True) + "\n")
    return 0


def _cmd_verify(args: list[str]) -> int:
    if len(args) != 2:
        _die("verify takes: <endpoint-file> <repo-root>")
    endpoint_file, root_arg = args
    data = _load(endpoint_file)
    root = Path(root_arg)
    receipt = root / data["receipt"]
    rows = [row for row in parse_costs(receipt) if row.cost_key == data["cost_key"]]
    violations: list[str] = []

    if not receipt.is_file():
        violations.append(
            f"pending commit — frozen token endpoint names missing receipt "
            f"{data['receipt']!r}"
        )
    elif len(rows) != 1:
        violations.append(
            f"pending commit — frozen token endpoint cost-key {data['cost_key']!r} "
            f"appears {len(rows)} times in {data['receipt']}; expected exactly one row"
        )
    else:
        row = rows[0]
        expected = (
            data["input"], data["cache_create"], data["cache_read"], data["output"]
        )
        got = (
            row.cum_input, row.cum_cache_create, row.cum_cache_read, row.cum_output
        )
        if row.session != data["session"] or got != expected:
            violations.append(
                f"pending commit — frozen token endpoint for cost-key "
                f"{data['cost_key']!r} records session '{data['session'][:16]}…' "
                f"at (input={expected[0]} cache_create={expected[1]} "
                f"cache_read={expected[2]} output={expected[3]}), but the staged "
                f"receipt row has session '{row.session[:16]}…' at "
                f"(input={got[0]} cache_create={got[1]} cache_read={got[2]} "
                f"output={got[3]})"
            )

    for v in violations:
        print(v)
    return 1 if violations else 0


COMMANDS = {"write": _cmd_write, "verify": _cmd_verify}


def main(argv: list[str]) -> int:
    if not argv or argv[0] not in COMMANDS:
        _die(f"usage: endpoint.py <{'|'.join(COMMANDS)}> ...")
    return COMMANDS[argv[0]](argv[1:])


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
