#!/usr/bin/env python3
"""Cumulative reconciliation + per-session checkpoint for cost rows (issue #229).

Split out of `ledger.py` so each module stays focused (and under the
repo-hygiene file-size limit): `ledger.py` owns row schema / parse / append /
per-row validation; this module owns the two cross-row concerns the
event-sourced ledger added —

  * the **checkpoint**: the write path reads a session's last-written cumulative
    coordinate from a git-dir file (not from the receipts) to derive the
    per-commit delta, so a delta never depends on which sibling receipts happen
    to be visible in the current branch's tree.

  * **reconciliation**: in any tree where a session's consecutive rows are
    co-visible, prove `delta == cum(n) − cum(n−1)`; plus a per-session
    monotonicity / tamper check over the cumulative columns.

Stdlib-only. `reconcile_sessions` is duck-typed over `ledger.LedgerRow`
instances (it only reads attributes), so this module imports nothing from
`ledger` — keeping the dependency one-directional.
"""

from __future__ import annotations

import json
from pathlib import Path


# ── Checkpoint (per-session cumulative, in the git dir) ─────────────────────
# Survives branch switches within a worktree (the canonical one-issue-one-branch
# workflow). Missing/stale → degrades the derived delta (caught later by
# reconciliation), never blocks.


def _load_checkpoints(path: str | Path) -> dict:
    p = Path(path)
    if not p.is_file():
        return {}
    try:
        data = json.loads(p.read_text())
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def checkpoint_get(path: str | Path, session: str) -> tuple[int, int, int, int]:
    data = _load_checkpoints(path)
    vec = data.get(session)
    if isinstance(vec, list) and len(vec) == 4 and all(isinstance(x, int) for x in vec):
        return (vec[0], vec[1], vec[2], vec[3])
    return (0, 0, 0, 0)


def checkpoint_set(
    path: str | Path, session: str, ci: int, ccc: int, ccr: int, co: int
) -> None:
    p = Path(path)
    data = _load_checkpoints(p)
    data[session] = [ci, ccc, ccr, co]
    p.write_text(json.dumps(data))


# ── Cumulative reconciliation ───────────────────────────────────────────────


def reconcile_sessions(rows: list) -> list[str]:
    """Verify v4 cumulative coordinates across every session.

    Two independent checks, both over v4 rows only (legacy v3 rows have no
    `cum-*` and are skipped):

    1. **Monotonicity / tamper.** Sorted by `cum_total`, every cumulative
       component must be non-decreasing — a counter that goes backwards is
       corruption or a hand-edit.

    2. **Delta reconciliation.** A row's delta claims `cum(n) − cum(n−1)` where
       n−1 is the immediately preceding event. We locate the predecessor `P` as
       the visible row with the greatest `cum_total` strictly below this row's,
       and read the row's *implied* predecessor as `cum_total − delta_total`:
         - implied == cum(P)  → P is the true predecessor; enforce the claim
           per-component (`delta == cum(n) − cum(P)`).
         - implied  < cum(P)  → the claim skips over a visible row (it counted
           tokens that belong to P or earlier) — the double-count signature.
           Hard fail.
         - implied  > cum(P)  → the true predecessor is not in this tree (a
           sibling branch hasn't merged, or the predecessor was abandoned).
           Undecidable here — skip; the merged tree / main CI is the backstop.
    """
    violations: list[str] = []
    by_session: dict[str, list] = {}
    for r in rows:
        if r.has_cum and r.session:
            by_session.setdefault(r.session, []).append(r)

    for session, srows in by_session.items():
        ordered = sorted(srows, key=lambda r: r.cum_total)

        # (1) monotonicity over each cumulative component.
        for prev, cur in zip(ordered, ordered[1:]):
            for comp in ("cum_input", "cum_cache_create", "cum_cache_read", "cum_output"):
                if getattr(cur, comp) < getattr(prev, comp):
                    violations.append(
                        f"receipts — session '{session[:16]}…' {comp} decreases "
                        f"from {getattr(prev, comp)} (row '{prev.cost_key}') to "
                        f"{getattr(cur, comp)} (row '{cur.cost_key}') — cumulative "
                        f"counters are monotonic; this is corruption or a hand-edit"
                    )

        # (2) per-row delta reconciliation against the true predecessor.
        for r in srows:
            implied_prev_total = r.cum_total - r.delta_total
            preds = [x for x in srows if x.cum_total < r.cum_total]
            pred = max(preds, key=lambda x: x.cum_total) if preds else None
            prev_total = pred.cum_total if pred is not None else 0

            if implied_prev_total < prev_total:
                violations.append(
                    f"receipts — cost row '{r.cost_key}' claims a per-commit delta "
                    f"of {r.delta_total} tokens, but its cumulative coordinate sits "
                    f"only {r.cum_total - prev_total} above the previous co-visible "
                    f"row '{pred.cost_key}' for session '{session[:16]}…' — the claim "
                    f"double-counts tokens already attributed to an earlier commit. "
                    f"Backfill the delta columns to cum(n) − cum(n−1), or add a "
                    f"`governance: allow-agent-token-accounting <reason>` waiver if "
                    f"the predecessor is genuinely unrecoverable."
                )
                continue
            if implied_prev_total > prev_total:
                # True predecessor not co-visible — undecidable, skip.
                continue

            # implied == prev_total: P (or the 0-origin) is the true predecessor;
            # prove the claim component-by-component.
            base_i = pred.cum_input if pred is not None else 0
            base_cc = pred.cum_cache_create if pred is not None else 0
            base_cr = pred.cum_cache_read if pred is not None else 0
            base_co = pred.cum_output if pred is not None else 0
            for delta_val, cum_val, base_val, label in (
                (r.input, r.cum_input, base_i, "input"),
                (r.cache_create, r.cum_cache_create, base_cc, "cache_create"),
                (r.cache_read, r.cum_cache_read, base_cr, "cache_read"),
                (r.output, r.cum_output, base_co, "output"),
            ):
                if delta_val != cum_val - base_val:
                    where = f"row '{pred.cost_key}'" if pred is not None else "the session origin (0)"
                    violations.append(
                        f"receipts — cost row '{r.cost_key}' {label} delta ({delta_val}) "
                        f"!= cum(n) − cum(n−1) ({cum_val} − {base_val} = {cum_val - base_val}) "
                        f"against predecessor {where} for session '{session[:16]}…' — "
                        f"backfill the delta column to the reconciled value."
                    )
    return violations
