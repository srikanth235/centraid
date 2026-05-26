#!/usr/bin/env python3
"""Commit-trailer parsing for agent-token-accounting.

Each agent-authored commit carries a self-contained trailer block:

    Agent:        free-form runtime identifier
    Issue:        #N
    Session:      runtime session / thread id
    Token-Input:  non-negative int (= input_tokens + cache_creation_input_tokens)
    Token-Output: non-negative int (= output_tokens)
    Token-Total:  non-negative int (= Token-Input + Token-Output == row.new_work)
    Cost-Key:     <agent>-<session-short>-<epoch>
    Cost-USD:     4-decimal dollar figure (= ledger row's cost-usd cell).
                  Required on every agent commit — a truly unpriced model
                  blocks the commit upstream in the pre-commit hook rather
                  than slipping through as a blank.

GitHub squash-merge concatenates each sub-commit's body into the
resulting commit message, so the body can contain N such blocks. We
split on blank lines, treat each pure-trailer paragraph as one block,
and validate the (trailer-block, COSTS.md-row) pair anchored by each
block's `Cost-Key`. Parsing the whole body as one global last-wins bag
— the historical approach — kept only the trailing sub-commit's
trailers and silently skipped the rest, leaving every other sub-commit's
COSTS.md row unverified.

CLI:

    python3 trailers.py validate-blocks <label> <ledger_path> [msg_file|-]

        Reads the commit message, parses every trailer block, and prints
        one violation per line. Exits 1 if any, 0 if clean. The ledger
        cross-check is done per-block — each `Cost-Key` in the body must
        round-trip with exactly one row in COSTS.md, and the row's token
        columns must agree with that block's trailers.
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
_TRAILER_RE = re.compile(r"^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$")
_PARAGRAPH_RE = re.compile(r"\n[ \t]*\n")


def extract_trailer_blocks(msg: str) -> list[dict[str, str]]:
    """Split `msg` into trailer-only paragraphs.

    A paragraph qualifies as a trailer block when every non-blank line
    matches `Key: value`. Within a block, last-wins for repeated keys
    (matches git-interpret-trailers semantics for a single trailer
    section). Paragraphs that mix trailers with prose are dropped, so
    body text that happens to start with `Word:` doesn't masquerade
    as a trailer block.

    Necessary for squash-merge bodies: GitHub concatenates each
    sub-commit's body into the resulting commit, so the trailer
    section repeats N times. Parsing them as one global last-wins
    bag drops every sub-commit's trailers except the last one's, and
    only the last sub-commit's COSTS.md row gets cross-checked.
    """
    blocks: list[dict[str, str]] = []
    for para in _PARAGRAPH_RE.split(msg):
        lines = [ln for ln in para.splitlines() if ln.strip()]
        if not lines:
            continue
        block: dict[str, str] = {}
        all_trailer = True
        for ln in lines:
            m = _TRAILER_RE.match(ln)
            if not m:
                all_trailer = False
                break
            block[m.group(1)] = m.group(2).strip()
        if all_trailer and block:
            blocks.append(block)
    return blocks


def validate_blocks(
    msg: str,
    label: str,
    ledger_path: str | Path,
) -> list[str]:
    """Validate every per-Cost-Key trailer block in `msg`.

    Squash-merge bodies stack one trailer block per sub-commit; each
    Cost-Key in the body anchors its own (trailer, row) pair, and we
    cross-check every pair rather than just the trailing one.

    Caller is responsible for the "is this an in-scope commit?" gate —
    by the time we get here, the commit already declared an Agent:
    trailer somewhere in the body.
    """
    blocks = extract_trailer_blocks(msg)
    token_blocks = [b for b in blocks if "Cost-Key" in b]

    violations: list[str] = []
    if not token_blocks:
        violations.append(
            f"{label} — declares Agent: trailer but no token-accounting "
            f"trailer block (8-trailer set ending in Cost-Key/Cost-USD) "
            f"found in commit body"
        )
        return violations

    ledger_path = Path(ledger_path)
    rows = parse_ledger(ledger_path) if ledger_path.is_file() else []
    by_cost_key: dict[str, list] = {}
    for r in rows:
        by_cost_key.setdefault(r.cost_key, []).append(r)

    for block in token_blocks:
        violations.extend(
            _validate_block(block, label, by_cost_key, ledger_path)
        )
    return violations


def _validate_block(
    block: dict[str, str],
    label: str,
    by_cost_key: dict[str, list],
    ledger_path: Path,
) -> list[str]:
    violations: list[str] = []
    cost_key = block.get("Cost-Key", "")
    sublabel = f"{label} [Cost-Key {cost_key!r}]" if cost_key else label

    agent = block.get("Agent", "")
    if not agent:
        # A trailer block carrying Cost-Key without Agent is a stamping
        # error: every block must be a self-contained accounting tuple.
        violations.append(
            f"{sublabel} — trailer block has Cost-Key but no Agent: trailer"
        )
        return violations

    missing = [k for k in REQUIRED_TRAILERS if not block.get(k)]
    if missing:
        violations.append(
            f"{sublabel} — declares Agent: '{agent}' but block is missing "
            f"trailers: " + " ".join(missing)
        )
        return violations

    t_input = block["Token-Input"]
    t_output = block["Token-Output"]
    t_total = block["Token-Total"]

    if not (_INT_RE.match(t_input) and _INT_RE.match(t_output) and _INT_RE.match(t_total)):
        violations.append(
            f"{sublabel} — Token-Input/Output/Total must be non-negative "
            f"integers (got '{t_input}', '{t_output}', '{t_total}')"
        )
        return violations

    if int(t_input) + int(t_output) != int(t_total):
        violations.append(
            f"{sublabel} — Token-Total ({t_total}) != Token-Input ({t_input}) "
            f"+ Token-Output ({t_output})"
        )

    if not _COST_KEY_RE.match(cost_key):
        violations.append(
            f"{sublabel} — Cost-Key '{cost_key}' contains invalid characters "
            f"(allowed: A-Z a-z 0-9 . _ -)"
        )

    cost_trailer = block["Cost-USD"].strip()
    cost_shape_ok = bool(_COST_USD_RE.match(cost_trailer))
    if not cost_shape_ok:
        violations.append(
            f"{sublabel} — Cost-USD '{cost_trailer}' must be a non-negative "
            f"decimal"
        )

    # Look up matching ledger row.
    hits = by_cost_key.get(cost_key, [])
    if len(hits) != 1:
        if not ledger_path.is_file():
            violations.append(
                f"{sublabel} — declares Agent: trailer but COSTS.md does not "
                f"exist at repo root"
            )
        else:
            violations.append(
                f"{sublabel} — Cost-Key '{cost_key}' should have exactly 1 "
                f"row in COSTS.md, found {len(hits)}"
            )
        return violations

    row = hits[0]
    # Trailer Token-Input  = row.input + row.cache_create
    # Trailer Token-Output = row.output
    # Trailer Token-Total  = row.new_work  (both exclude cache_read)
    expected_trailer_input = row.input + row.cache_create
    expected_trailer_output = row.output
    if int(t_input) != expected_trailer_input or int(t_output) != expected_trailer_output:
        violations.append(
            f"{sublabel} — COSTS.md row for '{cost_key}' disagrees with commit "
            f"trailers (trailer input/output: {t_input}/{t_output}, "
            f"row input+cache_create / output: "
            f"{row.input}+{row.cache_create}={expected_trailer_input} / "
            f"{row.output})"
        )
    if int(t_total) != row.new_work:
        violations.append(
            f"{sublabel} — Token-Total ({t_total}) != COSTS.md row new_work "
            f"({row.new_work}) for cost-key '{cost_key}'"
        )

    if cost_shape_ok:
        if row.cost_usd is not None:
            if abs(float(cost_trailer) - row.cost_usd) > 5e-5:
                violations.append(
                    f"{sublabel} — Cost-USD trailer ({cost_trailer}) "
                    f"disagrees with COSTS.md cost_usd ({row.cost_usd:.4f}) "
                    f"for cost-key '{cost_key}'"
                )
        else:
            # Ledger row exists but has empty cost_usd — only legal for
            # legacy/grandfathered rows (empty model). A v3 commit
            # claiming ownership of such a row is an authoring error.
            violations.append(
                f"{sublabel} — Cost-USD trailer is '{cost_trailer}' but "
                f"COSTS.md row '{cost_key}' has no cost_usd value "
                f"(grandfathered row; new commits must point at a priced row)"
            )

    return violations


# ── CLI ───────────────────────────────────────────────────────────────────


def _read_msg(path_or_dash: str) -> str:
    if path_or_dash == "-":
        return sys.stdin.read()
    return Path(path_or_dash).read_text()


def _cmd_validate_blocks(argv: list[str]) -> int:
    if len(argv) < 2 or len(argv) > 3:
        print(
            "trailers validate-blocks: <label> <ledger_path> [msg_file | -]",
            file=sys.stderr,
        )
        return 2
    label, ledger_path = argv[0], argv[1]
    msg_src = argv[2] if len(argv) > 2 else "-"
    msg = _read_msg(msg_src)
    violations = validate_blocks(msg, label, ledger_path)
    for v in violations:
        print(v)
    return 1 if violations else 0


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0 if argv else 2
    cmd, rest = argv[0], argv[1:]
    if cmd == "validate-blocks":
        return _cmd_validate_blocks(rest)
    print(f"trailers: unknown command {cmd!r}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
