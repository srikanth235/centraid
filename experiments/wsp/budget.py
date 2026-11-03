"""The pass ledger: every use of the model by Astra is a pass, and passes are capped.

One generate pass is up to 512 items, one forward pass up to 1,024 texts; a call larger than one pass costs
ceil(n / cap) passes. The ledger is a JSON-lines file, one line per pass: {"pass": k, "kind": ..., "n": ...}.
A ledger that already exists is resumed: its lines count against the budget. `spend` charges before the model
runs and writes nothing when it raises.
"""

from __future__ import annotations

import json
from pathlib import Path

CAPS = {"generate": 512, "forward": 1024}


class BudgetExceeded(RuntimeError):
    pass


class Ledger:
    def __init__(self, path: str | Path, budget: int = 50) -> None:
        self.path = Path(path)
        self.budget = int(budget)
        self.entries: list[dict] = []
        if self.path.exists():
            for line in self.path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    self.entries.append(json.loads(line))
        self.used = len(self.entries)

    @property
    def passes_left(self) -> int:
        return max(self.budget - self.used, 0)

    def cost(self, kind: str, n: int) -> int:
        if kind not in CAPS:
            raise ValueError(f"unknown pass kind {kind!r}: one of {sorted(CAPS)}")
        return -(-int(n) // CAPS[kind]) if n > 0 else 0

    def spend(self, kind: str, n: int) -> list[int]:
        """Charge `n` items of `kind`; returns the pass numbers used. Raises BudgetExceeded (nothing written) if over."""
        passes = self.cost(kind, n)
        if self.used + passes > self.budget:
            raise BudgetExceeded(f"{kind} of {n} needs {passes} pass(es); {self.passes_left} of {self.budget} left")
        cap = CAPS[kind]
        numbers: list[int] = []
        new: list[dict] = []
        remaining = int(n)
        for _ in range(passes):
            chunk = min(cap, remaining)
            remaining -= chunk
            self.used += 1
            numbers.append(self.used)
            new.append({"pass": self.used, "kind": kind, "n": chunk})
        if new:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with open(self.path, "a", encoding="utf-8") as handle:
                for entry in new:
                    handle.write(json.dumps(entry, sort_keys=True) + "\n")
            self.entries.extend(new)
        return numbers
