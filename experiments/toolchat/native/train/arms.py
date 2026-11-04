"""The three arms of M6 (#1171): same data, same loss, three starting points.

    A   Qwen/Qwen3.5-0.8B                                      full SFT
    B   RikiyaT/Qwen3.5-0.8B-weight-space-programming          full SFT
    C   RikiyaT/Qwen3.5-0.8B-weight-space-programming          LoRA, adapters skip layers 15 and 19 `mlp.down_proj`

B's base is the stock model with two tensors edited, `layers.{15,19}.mlp.down_proj`. A full fine-tune may overwrite that edit; C tests it:
no adapter is placed on those two modules and the base is frozen, so the edit is untouched by construction. `snapshot` / `verify` check it at
export, after the adapters are merged: the two tensors must equal the base bit for bit.

`--arm` in train.py sets the base, the method and the default learning rate; an explicit `--lr` still wins, and a `--model` or `--lora` that
contradicts the arm is refused.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

import torch

STOCK = "Qwen/Qwen3.5-0.8B"
EDITED = "RikiyaT/Qwen3.5-0.8B-weight-space-programming"
EDITED_LAYERS = (15, 19)
TOKENIZER = STOCK  # every arm: the records were rendered and tokenised with it


@dataclass(frozen=True)
class Arm:
    name: str
    base: str
    lora_rank: int  # 0 = full fine-tune
    lr: float
    skip_layers: tuple[int, ...] = ()  # layers whose mlp.down_proj gets no adapter and is checked unchanged at export


ARMS = {
    "A": Arm("A", STOCK, 0, 2e-5),
    "B": Arm("B", EDITED, 0, 2e-5),
    # alpha = 2 * rank as train.py's --lora; the lr is the usual LoRA one, an order above full SFT
    "C": Arm("C", EDITED, 64, 2e-4, EDITED_LAYERS),
}


def apply_arm(a) -> Arm | None:
    """Resolve `--arm` on the parsed args `a` in place (model, lora, lr, tokenizer); None without an arm."""
    if not getattr(a, "arm", None):
        a.tokenizer = getattr(a, "tokenizer", None) or a.model
        return None
    arm = ARMS[a.arm]
    if a.model not in (None, STOCK, arm.base):
        raise SystemExit("--arm %s trains %s, not --model %s" % (arm.name, arm.base, a.model))
    if a.lora and a.lora != arm.lora_rank:
        raise SystemExit("--arm %s is %s; --lora %d contradicts it"
                         % (arm.name, "full SFT" if not arm.lora_rank else "LoRA rank %d" % arm.lora_rank, a.lora))
    a.model, a.lora = arm.base, arm.lora_rank
    if a.lr is None:
        a.lr = arm.lr
    a.tokenizer = a.tokenizer or TOKENIZER
    return arm


def _is_protected(name: str, layers) -> bool:
    return any(re.search(r"(^|\.)layers\.%d\.mlp\.down_proj(\.|$)" % k, name) for k in layers)


def protected_names(model, layers) -> list[str]:
    """Parameter names of the edited tensors (`...layers.K.mlp.down_proj.weight`); refuses a model that lacks one of them."""
    names = [n for n, _ in model.named_parameters() if _is_protected(n, layers)]
    if len(names) != len(tuple(layers)):
        raise SystemExit("expected %d edited tensors (layers %s mlp.down_proj), found %s" % (len(tuple(layers)), tuple(layers), names))
    return names


def lora_target_names(model, skip_layers=()) -> list[str]:
    """Full names of the modules that get an adapter: every nn.Linear of the language model's layers (what peft's "all-linear" picks there,
    without the head and the vision tower), except `mlp.down_proj` of `skip_layers`."""
    if skip_layers:
        protected_names(model, skip_layers)  # refuse early when the model has no such tensors
    names = [n for n, m in model.named_modules()
             if isinstance(m, torch.nn.Linear) and re.search(r"(^|\.)layers\.\d+\.", n) and "visual" not in n
             and not _is_protected(n, skip_layers)]
    if not names:
        raise SystemExit("no linear module to adapt")
    return names


def lora_config(model, rank: int, skip_layers=()):
    from peft import LoraConfig

    return LoraConfig(r=rank, lora_alpha=2 * rank, lora_dropout=0.0, target_modules=lora_target_names(model, skip_layers))


def adapted_modules(peft_model) -> list[str]:
    """Names of the modules that carry an adapter (as named in the model before it was wrapped)."""
    out = []
    for n, m in peft_model.named_modules():
        if hasattr(m, "lora_A") and hasattr(m, "base_layer"):
            out.append(n.replace("base_model.model.", "", 1))
    return sorted(out)


def snapshot(model, layers) -> dict:
    """A CPU copy of the protected tensors, taken before the adapters go on."""
    params = dict(model.named_parameters())
    return {n: params[n].detach().to("cpu", copy=True) for n in protected_names(model, layers)}


def verify(snap: dict, model) -> None:
    """The protected tensors of `model` (the base, adapters merged in) are bit-identical to `snap`; SystemExit otherwise."""
    params = {n.replace(".base_layer.", "."): p for n, p in model.named_parameters()}
    for n, ref in snap.items():
        got = params.get(n)
        if got is None or got.shape != ref.shape or not torch.equal(got.detach().to("cpu"), ref):
            raise SystemExit("the edited tensor %s changed: arm C must leave it untouched" % n)
