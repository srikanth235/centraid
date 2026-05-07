#!/usr/bin/env python3
"""Commit-trailer parsing for agent-token-accounting.

Trailers stamped onto agent-authored commits:

    Agent:        free-form runtime identifier
    Issue:        #N
    Session:      runtime session / thread id
    Token-Input:  non-negative int  (= input_tokens + cache_creation_input_tokens)
    Token-Output: non-negative int  (= output_tokens)
    Token-Total:  non-negative int  (= Token-Input + Token-Output == row.new_work)
    Cost-Key:     <agent>-<session-short>-<epoch>
    Cost-USD:     4-decimal dollar figure (= ledger row's cost-usd cell).
                  Required on every agent commit — a truly unpriced model
                  blocks the commit upstream in the pre-commit hook rather
                  than slipping through as a blank.

This module is the data-processing side of the directive script's Mode A /
Mode B validators — bash feeds a commit message on stdin or a file path,
Python returns a JSON blob with `trailers` and `violations`.

CLI:

    python3 -m trailers validate <label> <cost_key_found_in_ledger? 0|1> \\
                                 <ledger_input> <ledger_cache_create> \\
                                 <ledger_cache_read> <ledger_output> \\
                                 <ledger_total> <ledger_cost_usd> \\
                                 [msg_file | -]

        <ledger_cost_usd> is either a 4-decimal string or "-" meaning the
        row has no cost_usd (legacy row or unpriced model) — in that case
        the Cost-USD trailer cross-check is skipped.

        Stdin or file → commit message. Remaining args → the matching
        ledger row's numeric columns (if cost_key_found_in_ledger == 1).
        Prints one violation per line; exits 1 if any, 0 if clean.

        When cost_key_found_in_ledger == 0, the ledger cross-check is
        skipped and only the trailer-shape + math checks run. The bash
        caller handles the "zero or multiple ledger rows" case separately.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from pathlib import Path


REQUIRED_TRAILERS = (
    "Agent",
    "Issue",
    "Session",
    "Token-Input",
    "Token-Output",
    "Token-Total",
    "Cost-Key",
    "Cost-USD",
)

_INT_RE = re.compile(r"^[0-9]+$")
_COST_KEY_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_COST_USD_RE = re.compile(r"^\d+(?:\.\d+)?$")


@dataclass
class Trailers:
    agent: str = ""
    issue: str = ""
    session: str = ""
    token_input: str = ""
    token_output: str = ""
    token_total: str = ""
    cost_key: str = ""


def parse(msg: str) -> dict[str, str]:
    """Return a dict of trailer key → value. Keys are preserved as-is
    (case-sensitive). Only the *last* occurrence of a given key wins, matching
    git-interpret-trailers semantics for repeated keys."""
    out: dict[str, str] = {}
    for line in msg.splitlines():
        # A trailer is `Key: value` at the start of the line — but only in the
        # final paragraph. We accept any occurrence here; the directive script
        # already limits scope to commit message bodies.
        m = re.match(r"^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$", line)
        if m:
            out[m.group(1)] = m.group(2).strip()
    return out


def validate(
    msg: str,
    label: str,
    *,
    ledger_row: tuple[int, int, int, int, int] | None = None,
    ledger_cost_usd: float | None = None,
) -> list[str]:
    """Validate trailer set on a commit message.

    Args:
        msg: the full commit message.
        label: prefix for violation strings (e.g. "pending commit" or a SHA).
        ledger_row: if provided, a 5-tuple of
            (input, cache_create, cache_read, output, new_work) from the ledger
            row whose cost-key matches this commit. Cross-checks trailers
            against those numbers. None means "skip the cross-check" — the
            bash caller uses this when the ledger row is missing or duplicated
            (handled separately).

    Returns a list of violation strings (empty if clean).
    """
    trailers = parse(msg)
    agent = trailers.get("Agent", "")
    if not agent:
        # Not an agent commit. Nothing to validate.
        return []

    violations: list[str] = []

    missing = [k for k in REQUIRED_TRAILERS if not trailers.get(k)]
    if missing:
        violations.append(
            f"{label} — declares Agent: '{agent}' but is missing trailers: "
            + " ".join(missing)
        )
        return violations

    t_input = trailers["Token-Input"]
    t_output = trailers["Token-Output"]
    t_total = trailers["Token-Total"]
    cost_key = trailers["Cost-Key"]

    if not (_INT_RE.match(t_input) and _INT_RE.match(t_output) and _INT_RE.match(t_total)):
        violations.append(
            f"{label} — Token-Input/Output/Total must be non-negative integers "
            f"(got '{t_input}', '{t_output}', '{t_total}')"
        )
        return violations

    if int(t_input) + int(t_output) != int(t_total):
        violations.append(
            f"{label} — Token-Total ({t_total}) != Token-Input ({t_input}) + Token-Output ({t_output})"
        )

    if not _COST_KEY_RE.match(cost_key):
        violations.append(
            f"{label} — Cost-Key '{cost_key}' contains invalid characters "
            f"(allowed: A-Z a-z 0-9 . _ -)"
        )

    # Cross-check against the ledger row when one was found.
    if ledger_row is not None:
        row_input, row_cache_create, row_cache_read, row_output, row_new_work = ledger_row
        # Trailer Token-Input  = row.input + row.cache_create
        # Trailer Token-Output = row.output
        # Trailer Token-Total  = row.new_work  (both exclude cache_read)
        expected_trailer_input = row_input + row_cache_create
        expected_trailer_output = row_output
        if int(t_input) != expected_trailer_input or int(t_output) != expected_trailer_output:
            violations.append(
                f"{label} — COSTS.md row for '{cost_key}' disagrees with commit trailers "
                f"(trailer input/output: {t_input}/{t_output}, "
                f"row input+cache_create / output: "
                f"{row_input}+{row_cache_create}={expected_trailer_input} / {row_output})"
            )
        if int(t_total) != row_new_work:
            violations.append(
                f"{label} — Token-Total ({t_total}) != COSTS.md row new_work ({row_new_work}) "
                f"for cost-key '{cost_key}'"
            )

    # Cost-USD is required (REQUIRED_TRAILERS check above already enforced
    # presence). Validate shape and, when we have the matching ledger row,
    # cross-check value. Divergence means someone hand-edited one side.
    cost_trailer = trailers["Cost-USD"].strip()
    if not _COST_USD_RE.match(cost_trailer):
        violations.append(
            f"{label} — Cost-USD '{cost_trailer}' must be a non-negative decimal"
        )
    elif ledger_cost_usd is not None and ledger_row is not None:
        # Compare at 4dp — both sides are rounded to 4 decimals upstream.
        if abs(float(cost_trailer) - ledger_cost_usd) > 5e-5:
            violations.append(
                f"{label} — Cost-USD trailer ({cost_trailer}) disagrees with "
                f"COSTS.md cost_usd ({ledger_cost_usd:.4f}) for cost-key '{cost_key}'"
            )
    elif ledger_row is not None and ledger_cost_usd is None:
        # Ledger row exists but has empty cost_usd — that's only legal for
        # legacy/grandfathered rows (empty model). A v3 commit claiming
        # ownership of such a row is an authoring error, not a pass path.
        violations.append(
            f"{label} — Cost-USD trailer is '{cost_trailer}' but COSTS.md "
            f"row '{cost_key}' has no cost_usd value (grandfathered row; "
            f"new commits must point at a priced row)"
        )

    return violations


# ── CLI ───────────────────────────────────────────────────────────────────


def _read_msg(path_or_dash: str) -> str:
    if path_or_dash == "-":
        return sys.stdin.read()
    return Path(path_or_dash).read_text()


def _cmd_validate(argv: list[str]) -> int:
    if len(argv) < 9:
        print(
            "trailers validate: <label> <cost_key_found_in_ledger: 0|1> "
            "<input> <cache_create> <cache_read> <output> <total> "
            "<cost_usd|-> [msg_file | -]",
            file=sys.stderr,
        )
        return 2
    label = argv[0]
    found = argv[1] == "1"
    row_ints = [int(x) for x in argv[2:7]]
    cost_arg = argv[7]
    msg_src = argv[8] if len(argv) > 8 else "-"
    msg = _read_msg(msg_src)
    ledger_row = tuple(row_ints) if found else None  # type: ignore[assignment]
    ledger_cost_usd: float | None
    if not found or cost_arg in ("", "-"):
        ledger_cost_usd = None
    else:
        try:
            ledger_cost_usd = float(cost_arg)
        except ValueError:
            ledger_cost_usd = None
    violations = validate(  # type: ignore[arg-type]
        msg, label, ledger_row=ledger_row, ledger_cost_usd=ledger_cost_usd,
    )
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
