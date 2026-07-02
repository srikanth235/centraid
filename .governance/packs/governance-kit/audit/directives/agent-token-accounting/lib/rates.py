#!/usr/bin/env python3
"""Model → per-MTok USD rate lookup for cost-usd computation for receipt Costs rows.

Rates are per-million-tokens, split by usage mode:

    (base_input, cache_create_5m, cache_read, output)

The rate card itself is **data, not code**: it ships as the pack-owned
`defaults.conf` next to this directive (a sibling of `check.sh`), one
`rate <model> <base> <cache_create> <cache_read> <output>` row per model —
the same row format as the per-repo override file. `governance pack update`
refreshes `defaults.conf` like every other list-valued directive's defaults,
so a rate-card change ships as a data refresh rather than a code patch. This
module loads that file; it carries no hardcoded table.
Cache writes assume the **5-minute** TTL for Anthropic models, which is
Claude Code's default. OpenAI models do not charge a separate cache-write
rate in this ledger, so their cache-create rate matches base input.

Model lookup is tolerant:
  - lowercase + strip whitespace
  - strip a trailing date suffix like `-20250929` that Anthropic APIs attach
  - exact match first, then longest-prefix match (so `claude-sonnet-4-5-custom`
    still resolves to `claude-sonnet-4-5`)

Family-prefix fallbacks (`claude-opus`, `claude-sonnet`, `claude-haiku`,
`gpt-5`) are seeded in `defaults.conf` from the current production rate card so
that a new minor release between directive updates — e.g. `gpt-5.5` or
`claude-opus-4-8` — resolves to the nearest family schedule rather than falling
through to an empty `cost-usd` cell. Families shift slowly; version numbers
churn fast, so an estimated-but-present cost beats silently-zero. When an older
release has its own pricing (Opus 4.0/4.1), keep a version-specific row
alongside the family row — longest-prefix matching picks the version first.

Unknown model → `lookup()` returns None. The `cost` CLI exits non-zero
and emits nothing on stdout, so the pre-commit caller can distinguish
a real failure from a "cost=0.0000" priced row. Cost-USD is mandatory
on new commits, so an unknown model blocks the commit — the operator
adds a `rate <model> ...` row to `.governance/conf/governance-kit/audit/agent-token-accounting.conf`
(the user-owned override file, which survives `governance pack update`),
or for a built-in default a family-prefix row to `defaults.conf` here, or
waives via `SKIP_GOVERNANCE=1` for a hot-fix. The directive script's ledger
validator still tolerates legacy rows with an empty `cost-usd` cell
(grandfathered — pre-mandate history).

Two rate tables, one format, merged at lookup: `load_defaults()` reads the
pack-owned `defaults.conf`; `load_overrides()` reads
`.governance/conf/governance-kit/audit/agent-token-accounting.conf` and MERGES its
`rate` rows over the defaults (user rows win), so a repo with negotiated pricing
or a brand-new model never has to touch the pack-owned file. A malformed row in
either file raises `ValueError`; the CLI turns that into a non-zero exit that
blocks the commit.

This module is stdlib-only.

CLI:

    python3 rates.py cost <model> <input> <cache_create> <cache_read> <output>
        → prints the 4-decimal dollar cost on stdout and exits 0 when the
          model resolves. When the model is unpriced (no family-prefix
          match either), exits 3 with a human-readable reason on stderr
          and no stdout — the pre-commit hook propagates that as a hard
          failure so the commit doesn't land with a missing Cost-USD.
"""

from __future__ import annotations

import os
import re
import sys


_DATE_SUFFIX_RE = re.compile(r"-\d{8}$")

# Rate tuples are (base_input, cache_create_5m, cache_read, output) per MTok, USD.
# The pack-owned default rate card ships as `defaults.conf` at the directive
# root (sibling of check.sh), in the same `rate <model> ...` row format as the
# user overlay. Resolved from this file's installed location
# (`.../directives/<id>/lib/rates.py`) so it travels with the directive folder.
_DEFAULTS_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),  # .../directives/<id>
    "defaults.conf",
)

# User-owned per-repo price overrides live here, relative to the repo root.
# Each row is `rate <model> <base_input> <cache_create> <cache_read> <output>`
# (per-MTok USD). Overrides MERGE OVER the pack-owned defaults — a user adds a
# new model or corrects a price without editing defaults.conf (which a
# `governance pack update` refreshes). The overlay-row format and examples are
# documented in defaults.conf's header comments.
def _conf_rel() -> str:
    """Pack-qualified overlay path relative to the repo root:
    `.governance/conf/<owner>/<pack>/agent-token-accounting.conf`. Derived from
    this file's installed location
    (`.governance/packs/<owner>/<pack>/directives/<id>/lib/rates.py`) so homonym
    directives from different packs read independent overlays — matching
    `conf_file` in lib.sh. Falls back to the bare path when unresolved."""
    here = os.path.abspath(__file__)
    directive_dir = os.path.dirname(os.path.dirname(here))      # .../directives/<id>
    pack_dir = os.path.dirname(os.path.dirname(directive_dir))  # .../<owner>/<pack>
    pack = os.path.basename(pack_dir)
    owner = os.path.basename(os.path.dirname(pack_dir))
    if owner and pack and os.path.basename(os.path.dirname(directive_dir)) == "directives":
        return os.path.join(".governance", "conf", owner, pack, "agent-token-accounting.conf")
    return os.path.join(".governance", "conf", "agent-token-accounting.conf")


_CONF_REL = _conf_rel()


def normalize(model: str) -> str:
    """`claude-opus-4-5-20250929` → `claude-opus-4-5`."""
    m = (model or "").lower().strip()
    return _DATE_SUFFIX_RE.sub("", m)


def _find_conf() -> str | None:
    """Walk up from the CWD to find `.governance/conf/governance-kit/audit/agent-token-accounting.conf`.
    The pre-commit hook and run.sh both invoke with the repo root as CWD; the
    walk-up keeps it correct from a subdirectory too. None if not found."""
    d = os.path.abspath(os.getcwd())
    while True:
        candidate = os.path.join(d, _CONF_REL)
        if os.path.isfile(candidate):
            return candidate
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


def _parse_rate_rows(path: str) -> dict[str, tuple[float, float, float, float]]:
    """Parse a `rate <model> <base> <cache_create> <cache_read> <output>` file
    into a model → rates map. Blank lines and `#` comments are ignored. Raises
    ValueError on any malformed row — a bad price table must fail loudly, never
    silently misprice a commit. Shared by the pack-owned defaults and the user
    overlay so the two files stay byte-for-byte the same format."""
    out: dict[str, tuple[float, float, float, float]] = {}
    with open(path, encoding="utf-8") as fh:
        for lineno, raw in enumerate(fh, 1):
            line = raw.split("#", 1)[0].strip()
            if not line:
                continue
            parts = line.split()
            if parts[0] != "rate":
                raise ValueError(
                    f"{path}:{lineno}: unrecognized line {line!r} — rate rows "
                    f"must start with `rate` (or be a `#` comment)"
                )
            if len(parts) != 6:
                raise ValueError(
                    f"{path}:{lineno}: malformed rate row — expected "
                    f"`rate <model> <base_input> <cache_create> <cache_read> <output>`"
                )
            model = parts[1].lower().strip()
            try:
                nums = tuple(float(x) for x in parts[2:])
            except ValueError:
                raise ValueError(
                    f"{path}:{lineno}: rate row for {model!r} has a non-numeric price"
                ) from None
            out[model] = nums
    return out


def load_defaults() -> dict[str, tuple[float, float, float, float]]:
    """The pack-owned default rate card from `defaults.conf`. Raises ValueError
    if the file is missing (a broken install — it ships with the directive) or
    holds a malformed row, so pricing fails loudly rather than going silently
    empty and blocking every commit with an unexplained 'unpriced model'."""
    if not os.path.isfile(_DEFAULTS_PATH):
        raise ValueError(
            f"{_DEFAULTS_PATH}: pack-owned rate card not found — the "
            f"agent-token-accounting directive is installed without its "
            f"defaults.conf. Reinstall or `governance pack update`."
        )
    return _parse_rate_rows(_DEFAULTS_PATH)


def load_overrides() -> dict[str, tuple[float, float, float, float]]:
    """Per-repo price overrides from the user overlay conf. Empty when no conf
    exists; a malformed row raises ValueError (same parser as the defaults)."""
    conf = _find_conf()
    if conf is None:
        return {}
    return _parse_rate_rows(conf)


def _prefix_match(norm: str, table: dict[str, tuple[float, float, float, float]],
                  best_key: str) -> tuple[str, tuple[float, float, float, float] | None]:
    """Longest-prefix lookup within one table; only beats `best_key` on a strictly
    longer key, so a same-length override (searched first) wins ties."""
    best_val: tuple[float, float, float, float] | None = None
    for key in table:
        if norm.startswith(key) and len(key) > len(best_key):
            best_key, best_val = key, table[key]
    return best_key, best_val


def lookup(model: str) -> tuple[float, float, float, float] | None:
    """Return `(base, cache_create, cache_read, output)` per-MTok rates, or
    None if the model isn't priced. User overrides merge over the pack-owned
    defaults: an exact override wins outright, and on a prefix match the override
    wins ties (defaults still win with a strictly longer, more-specific key)."""
    if not model:
        return None
    norm = normalize(model)
    defaults = load_defaults()
    overrides = load_overrides()
    # Exact match — override beats default.
    if norm in overrides:
        return overrides[norm]
    if norm in defaults:
        return defaults[norm]
    # Longest-prefix match across both tables — `claude-sonnet-4-5-custom-suffix`
    # finds the 4-5 row; `gpt-5.5` finds the `gpt-5` family row. Overrides are
    # searched first so an equal-length override prefix wins the tie.
    best_key, best_val = _prefix_match(norm, overrides, "")
    best_key, def_val = _prefix_match(norm, defaults, best_key)
    if def_val is not None:
        best_val = def_val
    return best_val


def compute_cost_usd(
    model: str,
    input_tok: int,
    cache_create_tok: int,
    cache_read_tok: int,
    output_tok: int,
) -> float | None:
    """Return the USD cost of one row's token usage, rounded to 4 decimals.
    None if the model isn't priced."""
    rates = lookup(model)
    if rates is None:
        return None
    r_base, r_cc, r_cr, r_out = rates
    cost = (
        input_tok * r_base
        + cache_create_tok * r_cc
        + cache_read_tok * r_cr
        + output_tok * r_out
    ) / 1_000_000.0
    return round(cost, 4)


# ── CLI ───────────────────────────────────────────────────────────────────


def _cmd_cost(argv: list[str]) -> int:
    if len(argv) != 5:
        print(
            "rates cost: <model> <input> <cache_create> <cache_read> <output>",
            file=sys.stderr,
        )
        return 2
    model = argv[0]
    try:
        tokens = [int(x) for x in argv[1:]]
    except ValueError:
        print("rates cost: token counts must be integers", file=sys.stderr)
        return 2
    try:
        cost = compute_cost_usd(model, *tokens)
    except ValueError as exc:
        # A malformed price override must fail loudly — block the commit so the
        # operator fixes `.governance/conf/governance-kit/audit/agent-token-accounting.conf`.
        print(f"rates cost: {exc}", file=sys.stderr)
        return 2
    if cost is None:
        # Unpriced → exit 3 so the pre-commit hook can distinguish this
        # from a priced row that happens to total $0. Stderr carries the
        # human-readable reason; stdout is empty.
        print(
            f"rates cost: model {model!r} has no entry in the rate card "
            f"(defaults.conf) and no family-prefix fallback matches; add a "
            f"`rate {model} ...` row to defaults.conf or the per-repo overlay",
            file=sys.stderr,
        )
        return 3
    print(f"{cost:.4f}")
    return 0


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0 if argv else 2
    cmd, rest = argv[0], argv[1:]
    if cmd == "cost":
        return _cmd_cost(rest)
    print(f"rates: unknown command {cmd!r}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
