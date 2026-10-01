"""Per-architecture LoRA target-module resolution, by inspecting the loaded model.

Written for the (now parked) Kaggle LoRA bake-off across Qwen 3.5, Gemma 4, Granite 4.0
and LFM2.5. The problem it solves: `["q_proj", "k_proj", "v_proj", "o_proj", ...]` is a
Llama-ism. On a hybrid stack most layers have no attention projections at all — Qwen 3.5
is 3 Gated-DeltaNet layers (`in_proj_qkvz`, `in_proj_ba`, `out_proj`) to every 1 full
attention layer, and Granite 4.0-H is Mamba-2 (`in_proj`, `out_proj`) plus
`input_linear`/`output_linear`. A hardcoded list applied to the wrong family attaches
LoRA to a handful of modules, trains almost nothing, and REPORTS A NUMBER ANYWAY. That
silent failure is the thing this module exists to make impossible.

So: enumerate the real `nn.Linear` leaves of the text stack, prefer the family's list
where it matches, fall back to every linear leaf where it does not, and then ASSERT the
trainable fraction into a sane band.

    from lora_targets import resolve_targets, attach_lora
    model, info = attach_lora(model, target_suffixes=[...], r=32, alpha=64)

No notebook dependencies; `torch` and `peft` only, and only when called.
"""

from __future__ import annotations

import collections
import re

# LoRA on a fraction outside this band is not LoRA on the right modules.
MIN_TRAINABLE_PCT = 0.05
MAX_TRAINABLE_PCT = 5.0

# Starting points per family. These are PREFERENCES, resolved against what the checkpoint
# actually has; a family missing from this map is handled by the fallback, not by failing.
FAMILY_TARGETS = {
    # dense transformer, the Llama lineage (also SmolLM2/3, Gemma 3)
    "llama": ["q_proj", "k_proj", "v_proj", "o_proj",
              "gate_proj", "up_proj", "down_proj"],
    "smollm3": ["q_proj", "k_proj", "v_proj", "o_proj",
                "gate_proj", "up_proj", "down_proj"],
    "gemma3_text": ["q_proj", "k_proj", "v_proj", "o_proj",
                    "gate_proj", "up_proj", "down_proj"],
    "gemma4": ["q_proj", "k_proj", "v_proj", "o_proj",
               "gate_proj", "up_proj", "down_proj"],
    # Phi packs qkv and gate/up into single projections
    "phi3": ["qkv_proj", "o_proj", "gate_up_proj", "down_proj"],
    # Qwen 3.5: hybrid Gated DeltaNet, 3 linear-attention layers : 1 full-attention layer
    "qwen3_5": ["q_proj", "k_proj", "v_proj", "o_proj",
                "gate_proj", "up_proj", "down_proj",
                "in_proj_qkvz", "in_proj_ba", "out_proj"],
    # Granite 4.0: hybrid Mamba-2 / transformer, MoE-shaped shared expert
    "granitemoehybrid": ["q_proj", "k_proj", "v_proj", "o_proj",
                         "in_proj", "out_proj", "input_linear", "output_linear",
                         "gate_proj", "up_proj", "down_proj"],
    # LFM2 / LFM2.5: short-convolution blocks plus attention
    "lfm2": ["q_proj", "k_proj", "v_proj", "out_proj", "in_proj",
             "w1", "w2", "w3", "gate_proj", "up_proj", "down_proj"],
}

# Output heads are never LoRA targets: adapting a 250k-row projection is not LoRA.
NEVER = {"lm_head", "score", "embed_out", "output"}


def text_prefix(model):
    """The submodule holding the language model, for a vision-language checkpoint.

    Qwen 3.5 and Gemma 4 are multimodal (`*ForConditionalGeneration`); this task is
    text-only, so the towers are loaded, frozen and left out of the target set.
    """
    for name, _module in model.named_modules():
        if re.search(r"(^|\.)(language_model|text_model)$", name):
            return name
    return ""


def linear_leaves(model, prefix=None):
    """{leaf name -> count} for every `nn.Linear` under the text stack."""
    import torch
    if prefix is None:
        prefix = text_prefix(model)
    leaves = collections.Counter()
    for name, module in model.named_modules():
        if not isinstance(module, torch.nn.Linear):
            continue
        if prefix and not name.startswith(prefix + "."):
            continue
        leaf = name.rsplit(".", 1)[-1]
        if leaf in NEVER:
            continue
        leaves[leaf] += 1
    return leaves


def resolve_targets(model, target_suffixes=None, family=None, verbose=True):
    """(regex, chosen, how, module_count).

    `target_suffixes` (or `family`, looked up in FAMILY_TARGETS) is the preference. What
    is not present in the checkpoint is dropped; if nothing matches, every linear leaf is
    targeted rather than silently adapting a handful of modules.
    """
    prefix = text_prefix(model)
    leaves = linear_leaves(model, prefix)
    if not leaves:
        raise RuntimeError("no nn.Linear modules under the text stack")
    preferred = list(target_suffixes or FAMILY_TARGETS.get(family or "", []))
    chosen = [s for s in preferred if leaves.get(s)]
    how = "the family list"
    if not chosen:
        chosen, how = list(leaves), "EVERY linear leaf (the family list matched nothing)"
    if verbose:
        print("text stack at %r; nn.Linear leaves:" % (prefix or "<whole model>"))
        for leaf, count in leaves.most_common():
            print("   %-20s %4d %s" % (leaf, count, "<-" if leaf in chosen else ""))
        print("targets (%s): %s" % (how, ", ".join(chosen)))
    regex = (("^%s\\." % re.escape(prefix)) if prefix else "") + \
            r".*\.(" + "|".join(re.escape(s) for s in chosen) + r")$"
    return regex, chosen, how, sum(leaves[s] for s in chosen)


def attach_lora(model, target_suffixes=None, family=None, r=32, alpha=64, dropout=0.05,
                min_pct=MIN_TRAINABLE_PCT, max_pct=MAX_TRAINABLE_PCT, verbose=True):
    """Wrap `model` in a PEFT LoRA, then assert the trainable fraction is sane."""
    from peft import LoraConfig, get_peft_model
    regex, chosen, how, count = resolve_targets(model, target_suffixes, family, verbose)
    model = get_peft_model(model, LoraConfig(
        r=r, lora_alpha=alpha, lora_dropout=dropout, bias="none",
        task_type="CAUSAL_LM", target_modules=regex))
    # fp16 master weights diverge under a GradScaler; keep the trainable parameters in
    # fp32 and let autocast handle the forward. On sm_60/sm_75 there is no bf16 to hide it.
    for _name, param in model.named_parameters():
        if param.requires_grad:
            param.data = param.data.float()
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total = sum(p.numel() for p in model.parameters())
    pct = 100.0 * trainable / total
    if verbose:
        print("trainable %s / %s = %.3f%%  over %d modules"
              % (f"{trainable:,}", f"{total:,}", pct, count))
    if not (min_pct <= pct <= max_pct):
        raise RuntimeError(
            "trainable fraction %.4f%% is outside [%.2f%%, %.2f%%].\n"
            "Below the floor means the target modules are wrong: this run would train "
            "almost nothing and report a number anyway. Above the ceiling means this is "
            "not LoRA. The real leaf names were printed above." % (pct, min_pct, max_pct))
    return model, {"targets": chosen, "how": how, "modules": count,
                   "trainable": trainable, "total": total, "trainable_pct": pct,
                   "regex": regex}
