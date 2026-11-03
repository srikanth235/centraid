# noop

Mechanism: none. `apply()` leaves every tensor as it is.

Evidence: `python apply_edit.py --base BASE --edit edits/noop --out OUT` must write an `edit.json` with
`changed_total == 0` and output safetensors files whose sha256 equals the base's. Any difference is a bug
in the harness (sharding, metadata, dtype), not in the edit.
