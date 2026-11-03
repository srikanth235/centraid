"""The lab Astra works in (DESIGN section 6).

    lab = Lab(model_dir, run="name", budget=50)
    lab.dev()                       # probe/dev.jsonl; the class holds no path to the hold split
    lab.generate(items)             # scored rows; 1 pass = up to 512 items
    lab.forward(texts, capture=["model.layers.15.mlp"], attn_layers=[3])   # 1 pass = up to 1,024 texts
    lab.tensors                     # name -> live parameter tensor, edit in place (under torch.no_grad() or via .data)
    lab.save_edit(name, code, notes)
    lab.passes_left

Everything is written under runs/<run>/: ledger.jsonl, and gen-<pass>.jsonl (+ .summary.json) for each generate call.
Reading weights is free; running the model costs passes (budget.py). No gradients: parameters are loaded with requires_grad off.

forward() returns
    {"tokens": [[ids]...],
     "capture": {module: {"last": Tensor[n, d], "mean": Tensor[n, d], "full": [Tensor[len_i, d]...] (full=True only)}},
     "attn": {layer: [Tensor[heads, len_i, len_i] or None per text]}}      # None: that layer has no softmax attention
`last` is the last real token, `mean` the mean over real tokens; all tensors are float32 on the CPU. Attention weights need the
eager implementation: when `attn_layers` is given and the model is not eager, the lab switches it (set_attn_implementation) or
raises with the remedy (load with Lab(..., attn_implementation="eager")). Qwen3.5 mixes linear-attention layers (no weights) with
full-attention layers; only the latter return weights.

Tensor names are the checkpoint's (as apply_edit.py sees them): a model parameter whose name differs from the safetensors key only by
the `language_model.` / leading `model.` prefix is renamed to the checkpoint key; others keep the model's name.
"""

from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import budget as budget_mod  # noqa: E402
import run as run_mod  # noqa: E402
import score as score_mod  # noqa: E402

DEV = HERE / "probe" / "dev.jsonl"
FORWARD_BATCH = 16


def _refuse_hold(value: Any, what: str) -> None:
    if "hold" in str(value).casefold():
        raise ValueError(f"{what} {str(value)!r} mentions 'hold': the lab never touches the hold split")


def _canon(name: str) -> str:
    name = name.replace("language_model.", "")
    return name[len("model."):] if name.startswith("model.") else name


class Lab:
    def __init__(self, model_dir: str, run: str, budget: int = 50, device: str = "auto", dtype: str = "bf16",
                 attn_implementation: str | None = None) -> None:
        _refuse_hold(model_dir, "model_dir")
        _refuse_hold(run, "run")
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", run):
            raise ValueError("run: letters, digits, _ . - only")
        import catalog as catalog_mod

        self.run_dir = HERE / "runs" / run
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self.ledger = budget_mod.Ledger(self.run_dir / "ledger.jsonl", budget)
        self.catalog = catalog_mod.load(str(HERE / "catalog" / "schemas.json"))
        self.model, self.tokenizer = run_mod.load_hf(model_dir, dtype, device, attn_implementation)
        self.model_dir = model_dir
        self.tensors = self._named_tensors(model_dir)

    # -- state
    @property
    def passes_left(self) -> int:
        return self.ledger.passes_left

    def dev(self) -> list[dict]:
        return run_mod.read_items(DEV)

    def _named_tensors(self, model_dir: str) -> dict[str, Any]:
        keys: dict[str, str] = {}
        path = Path(model_dir)
        if path.is_dir():
            from safetensors import safe_open

            for f in sorted(path.glob("*.safetensors")):
                with safe_open(str(f), "pt") as handle:
                    for key in handle.keys():
                        keys.setdefault(_canon(key), key)
        out: dict[str, Any] = {}
        for name, param in self.model.named_parameters():
            out[keys.get(_canon(name), name)] = param
        return out

    # -- passes
    def generate(self, items: list[dict], batch: int = 16, k: int = 8,
                 think_cap: int = run_mod.THINK_CAP, max_new: int = run_mod.MAX_NEW) -> list[dict]:
        """Run `items` in the phone's regime; returns one dict per item: the run row plus its score fields (key `score`)."""
        passes = self.ledger.spend("generate", len(items))
        rows = run_mod.generate_items(self.model, self.tokenizer, items, self.catalog, batch=batch, k=k,
                                       think_cap=think_cap, max_new=max(max_new, think_cap + 312))
        by_id = {i["id"]: i for i in items}
        out = []
        for row in rows:
            item = by_id[row["id"]]
            scored = score_mod.score_item(item, row, self.catalog) if "gold" in item else None
            out.append({**row, "score": scored})
        tag = f"{passes[0]:03d}" if passes else "000"
        (self.run_dir / f"gen-{tag}.jsonl").write_text("".join(json.dumps(r, sort_keys=True) + "\n" for r in out), encoding="utf-8")
        scored_all = [r["score"] for r in out if r["score"]]
        if scored_all:
            (self.run_dir / f"gen-{tag}.summary.json").write_text(
                json.dumps(score_mod.summarize(scored_all), indent=1, sort_keys=True) + "\n", encoding="utf-8")
        return out

    def forward(self, texts: list[str], capture: list[str] | None = None, attn_layers: list[int] | None = None,
                full: bool = False) -> dict[str, Any]:
        import torch

        capture, attn_layers = capture or [], attn_layers or []
        self.ledger.spend("forward", len(texts))
        if attn_layers and getattr(self.model.config, "_attn_implementation", None) != "eager":
            try:
                self.model.set_attn_implementation("eager")
            except Exception as why:  # noqa: BLE001
                raise RuntimeError("attention weights need attn_implementation='eager': construct Lab(..., attn_implementation='eager')") from why
        tok = self.tokenizer
        tok.padding_side = "right"
        store: dict[str, Any] = {}
        hooks = []
        for name in capture:
            module = self.model.get_submodule(name)

            def hook(_m: Any, _i: Any, output: Any, name: str = name) -> None:
                store[name] = (output[0] if isinstance(output, tuple) else output).detach()

            hooks.append(module.register_forward_hook(hook))
        result: dict[str, Any] = {"tokens": [], "capture": {n: {"last": [], "mean": [], **({"full": []} if full else {})} for n in capture},
                                  "attn": {int(l): [] for l in attn_layers}}
        try:
            with torch.no_grad():
                for start in range(0, len(texts), FORWARD_BATCH):
                    enc = tok(texts[start:start + FORWARD_BATCH], return_tensors="pt", padding=True, add_special_tokens=False).to(self.model.device)
                    out = self.model(**enc, output_attentions=bool(attn_layers))
                    lengths = enc["attention_mask"].sum(1).tolist()
                    for b, length in enumerate(lengths):
                        result["tokens"].append(enc["input_ids"][b, :length].tolist())
                        for name in capture:
                            h = store[name][b, :length].float().cpu()
                            slot = result["capture"][name]
                            slot["last"].append(h[-1])
                            slot["mean"].append(h.mean(0))
                            if full:
                                slot["full"].append(h)
                        for layer in attn_layers:
                            w = out.attentions[layer] if out.attentions is not None else None
                            result["attn"][int(layer)].append(None if w is None else w[b, :, :length, :length].float().cpu())
        finally:
            for h in hooks:
                h.remove()
        for slot in result["capture"].values():
            slot["last"], slot["mean"] = torch.stack(slot["last"]), torch.stack(slot["mean"])
        return result

    # -- edits
    def save_edit(self, name: str, code: str, notes: str) -> Path:
        """Write edits/<name>/edit.py and NOTES.md. The code must parse and define apply(tensors)."""
        _refuse_hold(name, "edit name")
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", name):
            raise ValueError("edit name: lowercase letters, digits, - and _")
        tree = ast.parse(code)
        if not any(isinstance(n, ast.FunctionDef) and n.name == "apply" for n in tree.body):
            raise ValueError("edit.py must define apply(tensors) at module level")
        target = HERE / "edits" / name
        target.mkdir(parents=True, exist_ok=True)
        (target / "edit.py").write_text(code if code.endswith("\n") else code + "\n", encoding="utf-8")
        (target / "NOTES.md").write_text(notes if notes.endswith("\n") else notes + "\n", encoding="utf-8")
        return target
