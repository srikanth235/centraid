"""Apply an edit to a checkpoint (DESIGN section 7).

    python3 apply_edit.py --base DIR --edit edits/<name> --out DIR [--force]

Loads every `*.safetensors` of --base (with `safetensors.torch`), imports `apply(tensors)` from `<edit>/edit.py` by path, applies it in
place, and writes the same shards (same file names, same tensor-to-file assignment, same metadata) to --out together with the other
files of --base (config, tokenizer, index...). The edit may change values only: names, shapes and dtypes must stay. Writes
`--out/edit.json`: sha256 of every base and output file, the edit's own sha256, changed elements per tensor (torch.ne; NaN against NaN
is unchanged), the total, and the fraction of all parameters. Deterministic: no clock, sorted keys.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import shutil
import sys
from pathlib import Path
from typing import Any


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def load_edit(edit: Path) -> tuple[Any, Path]:
    path = edit if edit.suffix == ".py" else edit / "edit.py"
    spec = importlib.util.spec_from_file_location("wsp_edit", path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot import {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if not callable(getattr(module, "apply", None)):
        raise SystemExit(f"{path} defines no apply(tensors)")
    return module, path


def changed_count(before: Any, after: Any) -> int:
    import torch

    diff = torch.ne(before, after)
    if before.is_floating_point():
        diff &= ~(torch.isnan(before) & torch.isnan(after))
    return int(diff.sum().item())


def apply_edit(base: Path, edit: Path, out: Path, force: bool = False) -> dict[str, Any]:
    import torch
    from safetensors import safe_open
    from safetensors.torch import load_file, save_file

    shards = sorted(base.glob("*.safetensors"))
    if not shards:
        raise SystemExit(f"{base} has no *.safetensors")
    if out.exists() and any(out.iterdir()) and not force:
        raise SystemExit(f"{out} is not empty (use --force)")
    module, edit_path = load_edit(edit)
    layout: dict[str, tuple[list[str], dict[str, str]]] = {}
    tensors: dict[str, Any] = {}
    for shard in shards:
        with safe_open(str(shard), "pt") as handle:
            meta = dict(handle.metadata() or {})
        loaded = load_file(str(shard))
        layout[shard.name] = (list(loaded.keys()), meta)
        tensors.update(loaded)
    before = {k: v.clone() for k, v in tensors.items()}
    with torch.no_grad():
        module.apply(tensors)
    if set(tensors) != set(before):
        raise SystemExit(f"edit changed the tensor names: +{sorted(set(tensors) - set(before))} -{sorted(set(before) - set(tensors))}")
    changed: dict[str, int] = {}
    total_params = 0
    for name, old in before.items():
        new = tensors[name]
        if new.shape != old.shape or new.dtype != old.dtype:
            raise SystemExit(f"{name}: shape/dtype changed {tuple(old.shape)} {old.dtype} -> {tuple(new.shape)} {new.dtype}")
        total_params += old.numel()
        n = changed_count(old, new)
        if n:
            changed[name] = n
    out.mkdir(parents=True, exist_ok=True)
    for shard in shards:
        keys, meta = layout[shard.name]
        save_file({k: tensors[k].contiguous() for k in keys}, str(out / shard.name), metadata=meta or None)
    base_files = sorted(p for p in base.iterdir() if p.is_file())
    for p in base_files:
        if p.suffix != ".safetensors":
            shutil.copyfile(p, out / p.name)
    total_changed = sum(changed.values())
    info = {
        "base": str(base),
        "edit": {"file": str(edit_path), "sha256": sha256_file(edit_path)},
        "base_files": {p.name: sha256_file(p) for p in base_files},
        "output_files": {p.name: sha256_file(p) for p in sorted(out.iterdir()) if p.is_file() and p.name != "edit.json"},
        "changed_per_tensor": dict(sorted(changed.items())),
        "changed_total": total_changed,
        "params_total": total_params,
        "fraction_changed": total_changed / total_params if total_params else 0.0,
    }
    (out / "edit.json").write_text(json.dumps(info, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    return info


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--base", required=True, type=Path)
    ap.add_argument("--edit", required=True, type=Path, help="edits/<name> (or its edit.py)")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--force", action="store_true", help="write into a non-empty --out")
    args = ap.parse_args(argv)
    info = apply_edit(args.base, args.edit, args.out, args.force)
    print(f"changed {info['changed_total']:,} of {info['params_total']:,} elements ({info['fraction_changed']:.3e}) in {len(info['changed_per_tensor'])} tensors")
    return 0


if __name__ == "__main__":
    sys.exit(main())
