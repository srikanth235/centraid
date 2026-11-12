"""LoRA on the stock base, resumable on any storage. The one place that imports torch.

What is trained: adapters on `config.target_regex(job.lora.targets)` of the language model's layers; every other parameter (embeddings,
head, norms, the vision tower) is frozen, and nothing is added to the vocabulary. The loss is the datagen records' own (`datagen.py` of the
native trainer: the rendered token ids and per-token weights, taken as they are):

    sum_t weight[t] * CE(logits[t-1], ids[t]) / sum_t weight[t]      over a step's `bs` records

One record at a time (no padding: Qwen3.5's linear-attention layers make a padded batch a risk for nothing), accumulated into one step.

RESUME. A checkpoint is `adapter/` (peft), `optimizer.pt` and `state.json`; `run` resumes from the newest complete one under
`job.checkpoints` whatever machine wrote it, and refuses one written for a different job file. Which records step N reads is a pure function
of (seed, N), so a resumed run sees the data a straight run would have. A SIGTERM (a Spot reclaim) is `stop`: a checkpoint is written at the
next step boundary and `run` returns `done=False`; the launcher's restart resumes.

CPU-testable with a tiny random model through `base_loader`; the CUDA path is not exercised by any test here.
"""
from __future__ import annotations

import json
import math
import random
import shutil
import sys
import tempfile
from pathlib import Path

from . import checkpoints, config, record, storage

_NATIVE = Path(__file__).resolve().parents[2] / "toolchat" / "native" / "train"


def _datagen():
    if str(_NATIVE) not in sys.path:
        sys.path.insert(0, str(_NATIVE))
    import datagen  # noqa: PLC0415 - the native trainer's record reader: one implementation of the loss's input

    return datagen


class NotBuilt(NotImplementedError):
    """A seam that is a decision with a cost, not an accident: the message says the cost."""


def batch_for_step(n: int, bs: int, seed: int, step: int) -> list[int]:
    """The record indices step `step` reads, as a pure function of the seed: epochs are seeded shuffles of range(n), laid end to end."""
    first = step * bs
    out, epoch, order = [], first // n, None
    pos = first - epoch * n
    while len(out) < bs:
        if order is None:
            order = list(range(n))
            random.Random(seed * 1_000_003 + epoch).shuffle(order)
        take = order[pos:pos + bs - len(out)]
        out += take
        pos += len(take)
        if pos >= n:
            epoch, pos, order = epoch + 1, 0, None
    return out


def lr_at(job, step: int) -> float:
    """Linear warmup, then cosine down to a tenth of the learning rate."""
    s = job.schedule
    if step < s.warmup:
        return s.lr * (step + 1) / s.warmup
    t = (step - s.warmup) / max(1, s.steps - s.warmup)
    return s.lr * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * min(1.0, t))))


def load_base(job, device):
    """The base model as the job names it. `q4_0_dequantised` (fit the adapter to the phone's own weights) is the seam below."""
    import torch
    from transformers import AutoModelForCausalLM

    if job.base_weights == "q4_0_dequantised":
        raise NotBuilt(
            "base.weights 'q4_0_dequantised' is not built. Cost: map the Q4_0 GGUF's tensors back to Hugging Face names (the converter's inverse: "
            "ssm_a = -exp(A_log), conv1d unsqueezed, token_embd Q8_0), dequantise with gguf-py, load into the same architecture, and prove it "
            "by matching llama.cpp's logits on a prompt: about a day with a GPU and the pinned llama.cpp tree, and the parity step needs it."
        )
    dtype = torch.bfloat16 if device == "cuda" else torch.float32
    model = AutoModelForCausalLM.from_pretrained(job.base_model, revision=job.base_revision, dtype=dtype)
    return model.to(device)


def wrap(model, job):
    """Freeze everything, put adapters on the targets, and refuse a model on which they landed nowhere."""
    from peft import LoraConfig, get_peft_model

    for p in model.parameters():
        p.requires_grad_(False)
    model.config.use_cache = False
    cfg = LoraConfig(r=job.lora.rank, lora_alpha=job.lora.alpha, lora_dropout=job.lora.dropout, bias="none",
                     target_modules=config.target_regex(job.lora.targets), task_type="CAUSAL_LM")
    try:
        peft_model = get_peft_model(model, cfg)
    except ValueError as e:  # peft's "target modules not found" (NoMatchingPeftModuleError)
        raise config.ConfigError("no module of the model matches the lora targets %s (%s)"
                                 % (", ".join(job.lora.targets), e)) from e
    adapted = sorted(n for n, m in peft_model.named_modules() if hasattr(m, "lora_A") and hasattr(m, "base_layer"))
    if not adapted:
        raise config.ConfigError("no module of the model matches the lora targets %s" % ", ".join(job.lora.targets))
    trainable = [n for n, p in peft_model.named_parameters() if p.requires_grad]
    stray = [n for n in trainable if "lora_" not in n]
    if stray:
        raise RuntimeError("a parameter outside the adapters is trainable: %s" % stray[0])
    return peft_model, adapted


def _logits(model, ids, labels, device):
    import torch

    x = torch.tensor([ids], device=device)
    y = torch.tensor(labels[1:], device=device)
    pos = torch.nonzero(y != _datagen().IGNORE).squeeze(1)
    out = model(input_ids=x, logits_to_keep=pos, use_cache=False)
    return out.logits[0].float(), y[pos], pos


def record_loss(model, rec, device):
    """`(weighted CE sum, label tokens, correct tokens)` of one record; the caller divides by the batch's weight mass."""
    import torch

    logits, tgt, pos = _logits(model, rec["input_ids"], rec["labels"], device)
    w = torch.tensor(list(rec["weights"][1:]), dtype=torch.float32, device=device)[pos]
    ce = torch.nn.functional.cross_entropy(logits, tgt, reduction="none")
    return (ce * w).sum(), int(pos.numel()), int((logits.argmax(-1) == tgt).sum())


def evaluate(model, records, device) -> dict:
    import torch

    model.eval()
    tot = mass = n = hit = 0.0
    with torch.no_grad():
        for rec in records:
            s, k, c = record_loss(model, rec, device)
            tot += float(s)
            mass += float(sum(rec["weights"][1:]))
            n += k
            hit += c
    model.train()
    return {"val_loss": tot / mass if mass else None, "val_token_accuracy": hit / n if n else None, "val_records": len(records)}


def _save_checkpoint(peft_model, opt, step, job, work) -> Path:
    import torch

    d = Path(tempfile.mkdtemp(prefix="ckpt-", dir=work))
    peft_model.save_pretrained(d / "adapter")
    torch.save({"optimizer": opt.state_dict(), "rng": torch.get_rng_state()}, d / "optimizer.pt")
    (d / "state.json").write_text(json.dumps({"step": step, "job_sha256": job.digest()}), encoding="utf-8")
    return d


def _load_checkpoint(peft_model, opt, d, job) -> int:
    import torch
    from peft import set_peft_model_state_dict
    from safetensors.torch import load_file

    state = json.loads((d / "state.json").read_text(encoding="utf-8"))
    if state["job_sha256"] != job.digest():
        raise config.ConfigError("the newest checkpoint was written for a different job file; use a new checkpoints location")
    set_peft_model_state_dict(peft_model, load_file(str(d / "adapter" / "adapter_model.safetensors")))
    saved = torch.load(d / "optimizer.pt", map_location="cpu", weights_only=True)
    opt.load_state_dict(saved["optimizer"])
    torch.set_rng_state(saved["rng"])
    return int(state["step"])


def run(job, work, *, stop=lambda: False, base_loader=None, device=None, log=print, hf_fetch=None) -> dict:
    """Train `job` to completion or to a `stop`. Returns `{"done": bool, "step": int, "metrics": {...}}`; on completion the adapter and
    the run record are in `job.outputs`."""
    import torch

    work = Path(work)
    work.mkdir(parents=True, exist_ok=True)
    device = device or ("cuda" if torch.cuda.is_available() else "cpu")
    dg = _datagen()

    entries, paths, source = {}, {}, None
    if job.hf:
        from . import hf  # noqa: PLC0415

        got = hf.fetch_version(job.hf, work / "data", with_val=job.with_val, fetch=hf_fetch or hf.https_fetch)
        paths, source = got["paths"], got["source"]
        wanted = {"train": (job.hf + "#" + hf.FILES["train"], job.train_sha256), "val": (job.hf + "#" + hf.FILES["val"], job.val_sha256)}
    else:
        wanted = {"train": (job.train, job.train_sha256), "val": (job.val, job.val_sha256)}
        for key, (uri, _) in wanted.items():
            if uri:
                suffix = Path(uri).suffix if Path(uri).suffix in (".zst", ".gz") else ""
                paths[key] = storage.get_file(uri, work / "data" / ("%s.jsonl%s" % (key, suffix)))
    for key, local in paths.items():
        uri, want = wanted[key]
        entries[key] = record.data_entry(uri, local)
        if want and entries[key]["sha256"] != want:
            raise config.ConfigError("data.%s is %s, the job file pins %s" % (key, entries[key]["sha256"], want))
    train, stats = dg.load(paths["train"], job.schedule.max_len)
    if not train:
        raise config.ConfigError("no training record fits max_len %d" % job.schedule.max_len)
    log("records: %s" % stats)
    val = dg.load(paths["val"], job.schedule.max_len)[0] if "val" in paths else []

    torch.manual_seed(job.schedule.seed)
    base = (base_loader or load_base)(job, device)
    peft_model, adapted = wrap(base, job)
    peft_model.train()
    params = [p for p in peft_model.parameters() if p.requires_grad]
    opt = torch.optim.AdamW(params, lr=job.schedule.lr, weight_decay=0.0)

    start, resumed = 0, None
    found = checkpoints.fetch_newest(job.checkpoints, work / "resume")
    if found:
        resumed = start = _load_checkpoint(peft_model, opt, found[1], job)
        log("resumed from step %d" % start)
    rec0 = record.build(job, data=entries, resumed_from=resumed, device=device, data_source=source)

    s = job.schedule
    step = start
    while step < s.steps:
        idx = batch_for_step(len(train), s.bs, s.seed, step)
        mass = sum(sum(train[i]["weights"][1:]) for i in idx)
        for g in opt.param_groups:
            g["lr"] = lr_at(job, step)
        opt.zero_grad(set_to_none=True)
        total = 0.0
        for i in idx:
            loss, _, _ = record_loss(peft_model, train[i], device)
            (loss / mass).backward()
            total += float(loss) / mass
        torch.nn.utils.clip_grad_norm_(params, s.grad_clip)
        opt.step()
        step += 1
        log("step %d/%d loss %.4f" % (step, s.steps, total))
        halted = stop()
        if step % s.checkpoint_every == 0 or halted or step == s.steps:
            d = _save_checkpoint(peft_model, opt, step, job, work)
            checkpoints.publish(d, job.checkpoints, step, s.keep_checkpoints)
            shutil.rmtree(d, ignore_errors=True)
        if halted and step < s.steps:
            return {"done": False, "step": step, "metrics": {}}

    metrics = evaluate(peft_model, val, device) if val else {}
    out = work / "out"
    peft_model.save_pretrained(out / "adapter")
    files = {p.relative_to(out).as_posix(): record.sha256_file(p) for p in sorted((out / "adapter").rglob("*")) if p.is_file()}
    (out / "run.json").write_text(record.dumps(record.finish(rec0, steps=step, metrics=metrics, adapter_files=files)), encoding="utf-8")
    storage.put_tree(out, job.outputs)
    return {"done": True, "step": step, "metrics": metrics, "adapted_modules": adapted}
