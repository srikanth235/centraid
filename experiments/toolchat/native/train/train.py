"""SFT trainer for Qwen3.5-0.8B, one sequence per session (SPEC §11.3, §11.7, §11.8).

    python train.py --train train.jsonl.gz --val val.jsonl.gz --out ckpt/ [--hours 8]
    torchrun --nproc_per_node 2 train.py ...        # data parallel (Kaggle's 2x T4)

- Text from the shared renderer (../render.py, thinking kept in history); loss on every
  assistant message's think + call through `<|im_end|>`, none on system, user or tool tokens
  (fmt.py). The mask is asserted on a sample (and against the data's `loss_tokens`) first.
- Full fine-tune of every transformer layer, fp32 master weights and optimizer state; compute in bf16 autocast + TF32 by default on a GPU (--autocast none --no-tf32 = the legacy pure-fp32 path; fp32 lm_head and loss either way). The tied embedding / lm_head (248k x 1024,
  a third of the model) is frozen by default (--embed freeze): full fp32 AdamW over all 0.75 B
  parameters is 12 GB before activations on a 15 GB T4; freezing it leaves ~9 GB. The call
  format uses tokens Qwen already has, so no new embeddings are needed. --embed train trains it.
- Logits are computed only at label positions (`logits_to_keep` as indices): full-sequence fp32
  logits over a 248k vocabulary would be ~8 GB for an 8k-token session.
- Sessions run 2.5–8k tokens: micro-batch 1 sequence (no padding), --bs sessions per optimizer
  step (gradient accumulation), gradient checkpointing. Before training, a memory probe runs the
  longest session forward + backward with the optimizer state held; on OOM it retries at 6144
  and 4096 tokens and drops longer sessions (logged), instead of dying hours in.
- One epoch; warmup then linear decay; grad clip 1.0.
- Checkpoints at 25 / 50 / 100 % of steps (bf16 safetensors + tokenizer), val loss and label-token
  accuracy on the val file at each; tokens/s logged. A hard wall-clock budget (--hours, default 8)
  stops training, saves, and marks the run TRUNCATED.
- Decision tokens (fmt.py: argument values of the call, think slot values, found structurally): the
  few label tokens that decide pass or fail. --decision-weight W (default 1.0 = the plain mean CE,
  bit-identical to before) multiplies their CE by W; the batch is normalised by its weight mass
  (sum of the weights), so the step's gradient scale stays that of a mean. At every eval (step 0 and
  each checkpoint) a fixed sample of --train-eval-n train records and the val file are scored for
  loss and accuracy on all label tokens AND on decision tokens only AND on the narrow HARD tier (fmt.py
  `HardConfig`: row refs and @k handles, row selectors, date expressions, verb / direction / op, the think
  slots stating them, the row numbers of `last`; a subset of the decision tokens, weighted by the same W,
  never by a second weight, and reported separately).
  --test PATH adds the same for the test file at the last eval only (the file is not opened before). --dry-run N stops after the
  tokenizer and mask assertions and one forward pass over N records.
- Preemption-safe resume (off unless asked; the defaults change nothing). --save-every N writes, every N steps,
  a RESUME checkpoint `out/resume-step-NNNNNN/` (trainable weights in the training dtype, AdamW state, LR
  scheduler, step / epoch / position in the shuffled order, RNG states, running meters, the eval history):
  written to a temp dir, fsynced, renamed, and only the latest two are kept. --resume [PATH] continues from
  the newest complete one (in --out, or PATH) at the next step, or starts fresh when there is none, so the same
  command line is safe to re-run after a preemption. A temp or incomplete checkpoint is never loaded. SIGTERM
  (given --save-every or --resume) writes a resume checkpoint at the next step boundary, if --term-grace allows,
  and exits 0 with out/PREEMPTED; a finished run writes out/DONE. The data order is a function of (--seed, epoch),
  so a resumed run sees exactly the batches an uninterrupted one would. --epochs N (default 1) repeats the file
  with a fresh shuffle per epoch. Exports at 25 / 50 / 100 % are unchanged.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import shutil
import signal
import sys
import time
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fmt  # noqa: E402


def log(*a):
    if RANK == 0:
        print(time.strftime("%H:%M:%S"), *a, flush=True)


RANK = int(os.environ.get("RANK", 0))
WORLD = int(os.environ.get("WORLD_SIZE", 1))


def load(tok, path, max_len, limit, default_tools, check_n, tag, cfg):
    """Examples as (input_ids, labels, decision) triples; `decision` is 0 or a fmt.PART_* per token."""
    data, dropped, bad, bare = [], 0, 0, 0
    for i, ex in enumerate(fmt.read_examples(path)):
        if limit and len(data) >= limit:
            break
        try:
            enc = fmt.encode(tok, ex, default_tools, cfg)
            if i < check_n:
                fmt.check_spans(ex, enc)
                fmt.check_decisions(enc, cfg)
        except ValueError as e:
            bad += 1
            if bad <= 3:
                log("SKIP %s #%d: %s" % (tag, i, e))
            continue
        if len(enc["input_ids"]) > max_len:
            dropped += 1
            continue
        if not any(enc["decision"]):
            bare += 1
        data.append((enc["input_ids"], enc["labels"], enc["decision"]))
    n_lab = sum(sum(1 for y in l if y != fmt.IGNORE) for _, l, _ in data)
    n_dec = sum(sum(1 for d in dc if d) for _, _, dc in data)
    n_hard = sum(sum(1 for d in dc if d & fmt.PART_HARD) for _, _, dc in data)
    no_hard = sum(1 for _, _, dc in data if not any(d & fmt.PART_HARD for d in dc))
    log("%s: %d examples, %d over max-len %d dropped, %d unrenderable skipped, %d label tokens (%d decision, %.1f%%; "
        "%d hard, %.1f%%; %d records without a hard token), %d tokens"
        % (tag, len(data), dropped, max_len, bad, n_lab, n_dec, 100 * n_dec / max(n_lab, 1), n_hard,
           100 * n_hard / max(n_lab, 1), no_hard, sum(len(x) for x, _, _ in data)))
    if bare:  # a silent no-op weight is worse than a stop: the labels do not match the think format
        raise SystemExit("%s: %d of %d records have no decision token; check --decision-labels against the "
                         "think format (fmt.py DecisionConfig)" % (tag, bare, len(data)))
    if data and cfg.hard is not None and not cfg.hard.empty and not n_hard:
        raise SystemExit("%s: a hard tier is configured but no record has a hard token; check --hard-labels and "
                         "--hard-params against the format (fmt.py HardConfig)" % tag)
    return data


def assert_mask_sample(tok, path, default_tools, cfg, n=8):
    """SPEC §11.3: show and assert, on a sample, that the trained tokens are exactly the assistant
    messages' think + call tokens (through `<|im_end|>`), and nothing of system, user or tool."""
    for i, ex in enumerate(fmt.read_examples(path)):
        if i >= n:
            break
        enc = fmt.encode(tok, ex, default_tools, cfg)
        fmt.check_spans(ex, enc)
        fmt.check_decisions(enc, cfg)
        ids, labels = enc["input_ids"], enc["labels"]
        # a repair's rejected call (`loss: False`) is in the text but not trained on
        asst = [m for m in enc["records"] if m["role"] == "assistant" and m.get("loss", True)]
        # token runs of trained labels, one per assistant message, each decoding to think + call
        runs, cur = [], []
        for t, y in zip(ids, labels):
            if y != fmt.IGNORE:
                cur.append(t)
            elif cur:
                runs.append(cur)
                cur = []
        if cur:
            runs.append(cur)
        assert len(runs) == len(asst), (len(runs), len(asst))
        for run, m in zip(runs, asst):
            piece = tok.decode(run)
            assert piece.startswith((m.get("think") or "").strip()), (piece[:80], m.get("think", "")[:80])
            assert piece.endswith("</tool_call><|im_end|>"), piece[-60:]
            assert "<function=%s>" % m["tool"] in piece and piece.count("<tool_call>") == 1, piece
            for bad in ("<|im_start|>", "<tool_response>", "<tools>"):
                assert bad not in piece, (bad, piece[:120])
        masked = tok.decode([t for t, y in zip(ids, labels) if y == fmt.IGNORE])
        assert "<|im_start|>system" in masked and "<|im_start|>user" in masked
        # every assistant header stays masked, trained or not
        assert masked.count("<|im_start|>assistant\n<think>\n") == sum(m["role"] == "assistant" for m in enc["records"])
        if i == 0:
            log("MASK sample: %d tokens, %d trained (%d decision) over %d assistant messages; first trained run, "
                "decision tokens in [[ ]]:\n%s"
                % (len(ids), sum(1 for y in labels if y != fmt.IGNORE), sum(1 for d in enc["decision"] if d),
                   len(asst), show_decisions(tok, ids, labels, enc["decision"], runs[0])[:900]))
    log("MASK assertion passed on %d examples" % min(n, i + 1))


def show_decisions(tok, ids, labels, decision, run):
    """The first trained run decoded token by token, decision tokens wrapped in [[ ]]."""
    out, n = [], len(run)
    k = next(i for i, y in enumerate(labels) if y != fmt.IGNORE)
    for i in range(k, k + n):
        piece = tok.decode([ids[i]])
        out.append("[[%s]]" % piece if decision[i] else piece)
    return "".join(out)


def probe_memory(model, data, dev, n_train, weight=1.0, lengths=(None, 6144, 4096), enable_ckpt=None):
    """Fail fast instead of hours in: one forward + backward on the longest example (no update),
    with AdamW's two fp32 states (allocated lazily at the first step) held as ballast.
    On CUDA OOM, first (if `enable_ckpt` is given: gradient checkpointing is off by default) switch
    checkpointing on and retry the same length (same math, less memory), then retry at shorter caps;
    returns the largest length that fit (None = all)."""
    if dev.type != "cuda" or not data:
        return None
    ballast = torch.empty(2 * n_train, dtype=torch.float32, device=dev)
    for cap in lengths:
        pool = [d for d in data if cap is None or len(d[0]) <= cap]
        ids, labels, dec = max(pool, key=lambda d: len(d[0]))
        while True:
            try:
                torch.cuda.reset_peak_memory_stats(dev)
                loss, n, _, _ = forward_loss(model, ids, labels, dev, dec, weight)
                (loss / n).backward()
                model.zero_grad(set_to_none=True)
                log("MEMORY probe: %d tokens forward+backward with optimizer state, peak %.1f GiB of %.1f GiB"
                    % (len(ids), torch.cuda.max_memory_allocated(dev) / 2**30,
                       torch.cuda.get_device_properties(dev).total_memory / 2**30))
                del ballast
                torch.cuda.empty_cache()
                return cap
            except torch.cuda.OutOfMemoryError:
                loss = None
                model.zero_grad(set_to_none=True)
                torch.cuda.empty_cache()
                log("MEMORY probe: OOM at %d tokens" % len(ids))
                if enable_ckpt is None:
                    break
                enable_ckpt()
                enable_ckpt = None
                log("MEMORY probe: gradient checkpointing switched on, retrying %d tokens" % len(ids))
    raise SystemExit("even a %d-token example does not fit" % lengths[-1])


def resolve_autocast(mode):
    """auto -> bf16 on a CUDA GPU that supports it, else none (on CPU the default stays the exact fp32 path:
    bf16 autocast on CPU is slower there and only adds noise; ask for it with --autocast bf16)."""
    if mode == "auto":
        return "bf16" if torch.cuda.is_available() and torch.cuda.is_bf16_supported() else "none"
    return mode


def amp_smoke(model, data, dev, weight, explicit):
    """One forward + backward of the shortest example under autocast, compared with the fp32 forward. The
    Triton (fla) kernels or the conv path can hit a dtype mismatch under autocast that only a real GPU shows:
    with the default (auto) that turns autocast off and trains in fp32 with a loud log; an explicit
    --autocast bf16 re-raises. A relative loss gap over 5% is logged as a warning."""
    ids, labels, dec = min(data, key=lambda d: len(d[0]))
    try:
        loss, n, _, _ = forward_loss(model, ids, labels, dev, dec, weight)
        (loss / n).backward()
        model.zero_grad(set_to_none=True)
        got = float(loss) / n
    except (RuntimeError, TypeError, ValueError) as e:
        model.zero_grad(set_to_none=True)
        if explicit:
            raise
        AMP["dtype"] = None
        log("AUTOCAST unusable (%s: %s): falling back to fp32; the run continues without autocast" % (type(e).__name__, e))
        return False
    amp, AMP["dtype"] = AMP["dtype"], None
    try:
        with torch.no_grad():
            ref = float(forward_loss(model, ids, labels, dev, dec, weight)[0]) / n
    finally:
        AMP["dtype"] = amp
    log("AUTOCAST check: loss/token %.4f under bf16 vs %.4f fp32 (%.2f%% apart)" % (got, ref, 100 * abs(got - ref) / max(abs(ref), 1e-9)))
    if abs(got - ref) > 0.05 * max(abs(ref), 1e-9):
        log("WARNING: bf16 and fp32 losses differ by more than 5%; check the kernels")
    return True


# Autocast state, set by main() (None = the legacy pure-fp32 forward, what every direct caller sees).
AMP = {"dtype": None}


def label_logits(model, ids, labels, dev):
    """Logits at the label positions only -> (logits fp32 [n, vocab], targets, positions).

    Under autocast (AMP["dtype"] set) the transformer body runs in that dtype, then the label-position
    hidden states go through the lm_head in fp32 OUTSIDE autocast, so the logits (and the CE after them)
    keep fp32 precision: a bf16 logit near 20 is only good to ~0.1, which would blur the loss."""
    x = torch.tensor([ids], device=dev)
    y = torch.tensor(labels[1:], device=dev)
    pos = torch.nonzero(y != fmt.IGNORE).squeeze(1)
    if AMP["dtype"] is None:
        out = model(input_ids=x, logits_to_keep=pos, use_cache=False)
        return out.logits[0].float(), y[pos], pos
    base = model.get_base_model() if hasattr(model, "get_base_model") else model
    body = getattr(base, "model", None)
    if body is None:  # no separable body: bf16 logits, cast up
        with torch.autocast(dev.type, dtype=AMP["dtype"]):
            out = model(input_ids=x, logits_to_keep=pos, use_cache=False)
        return out.logits[0].float(), y[pos], pos
    with torch.autocast(dev.type, dtype=AMP["dtype"]):
        h = body(input_ids=x, use_cache=False).last_hidden_state
    return base.get_output_embeddings()(h[0, pos].float()), y[pos], pos


def token_weights(dec, pos, weight, dev):
    """Weight of each label position: `weight` on decision tokens, 1 elsewhere (dec aligned with labels)."""
    d = torch.tensor(dec[1:], device=dev)[pos] > 0
    return 1.0 + (weight - 1.0) * d.float(), d


def forward_loss(model, ids, labels, dev, dec=None, weight=1.0):
    """CE over label positions, logits only there. Returns (loss, n, n_correct, plain_sum).

    `loss` is what backward sees: the plain sum at weight 1.0 (the exact old code path, so the loss
    is bit-identical), else the sum of weight * CE (decision tokens `weight`, all others 1);
    `plain_sum` is the unweighted sum for logging."""
    return loss_from_logits(*label_logits(model, ids, labels, dev), dec, weight, dev)


def loss_from_logits(logits, tgt, pos, dec, weight, dev):
    correct = (logits.argmax(-1) == tgt).sum()
    if dec is None or weight == 1.0:
        loss = torch.nn.functional.cross_entropy(logits, tgt, reduction="sum")
        return loss, pos.numel(), correct, loss.detach()
    ce = torch.nn.functional.cross_entropy(logits, tgt, reduction="none")
    w, _ = token_weights(dec, pos, weight, dev)
    return (ce * w).sum(), pos.numel(), correct, ce.detach().sum()


def weight_mass(labels, dec, weight):
    """(label tokens, decision tokens, weight mass) of one example, first token excluded as in the loss."""
    n = sum(1 for y in labels[1:] if y != fmt.IGNORE)
    nd = sum(1 for d in dec[1:] if d)
    return n, nd, n + (weight - 1.0) * nd


def hard_mask(dec, pos, dev):
    """Bool mask over the label positions `pos`: the hard-tier tokens (fmt.PART_HARD bit of `dec`)."""
    return (torch.tensor(dec[1:], device=dev)[pos] & fmt.PART_HARD) > 0


def evaluate(model, data, dev):
    """Loss and accuracy on all label tokens, on decision tokens only and on hard tokens only (eval mode,
    no grad). Returns a dict: n/loss/acc, dn/dloss/dacc (decision), oloss (every other label token),
    hn/hloss/hacc (the hard tier, a subset of the decision tokens)."""
    model.eval()
    tot = torch.zeros(9, dtype=torch.float64, device=dev)  # loss n correct | dloss dn dcorrect | hloss hn hcorrect
    with torch.no_grad():
        for ids, labels, dec in data[RANK::WORLD]:
            logits, tgt, pos = label_logits(model, ids, labels, dev)
            ce = torch.nn.functional.cross_entropy(logits, tgt, reduction="none").double()
            hit = (logits.argmax(-1) == tgt).double()
            d = torch.tensor(dec[1:], device=dev)[pos] > 0
            h = hard_mask(dec, pos, dev)
            tot += torch.stack([ce.sum(), torch.tensor(float(pos.numel()), dtype=torch.float64, device=dev), hit.sum(),
                                ce[d].sum(), d.sum().double(), hit[d].sum(),
                                ce[h].sum(), h.sum().double(), hit[h].sum()])
    if WORLD > 1:
        torch.distributed.all_reduce(tot)
    model.train()
    loss, n, c, dl, dn, dc, hl, hn, hc = tot.tolist()
    return {"n": int(n), "loss": loss / max(n, 1), "acc": c / max(n, 1),
            "dn": int(dn), "dloss": dl / max(dn, 1), "dacc": dc / max(dn, 1),
            "oloss": (loss - dl) / max(n - dn, 1),
            "hn": int(hn), "hloss": hl / max(hn, 1), "hacc": hc / max(hn, 1)}


def report(tag, step, r):
    log("%s step %d loss %.4f acc %.4f over %d tokens | decision loss %.4f acc %.4f over %d tokens (%.1f%%) | "
        "other loss %.4f | hard loss %.4f acc %.4f over %d tokens (%.1f%%)"
        % (tag, step, r["loss"], r["acc"], r["n"], r["dloss"], r["dacc"], r["dn"], 100 * r["dn"] / max(r["n"], 1),
           r["oloss"], r["hloss"], r["hacc"], r["hn"], 100 * r["hn"] / max(r["n"], 1)))


RECOMMENDED_W = 3.0  # the approved recipe weight for the decision tokens (hard tokens ride on it)


def dry_run(model, data, dev, weight, launch_flags=""):
    """No training: one forward pass over `data`, and what the decision tokens are at `weight`:
    their share of the label tokens, of the weight mass, and of the weighted loss (the model's own
    per-token CE, here the untrained or given model); the same shares for the hard tier (a subset of
    the decision tokens, weighted by the same W). Ends with the recommended launch flags (W=3)."""
    model.eval()
    n = nd = nh = nh_dec = no_hard = 0
    ce_all = ce_dec = ce_hard = 0.0
    with torch.no_grad():
        for ids, labels, dec in data:
            logits, tgt, pos = label_logits(model, ids, labels, dev)
            ce = torch.nn.functional.cross_entropy(logits, tgt, reduction="none").double()
            d = torch.tensor(dec[1:], device=dev)[pos] > 0
            h = hard_mask(dec, pos, dev)
            assert not bool((h & ~d).any()), "a hard token that is not a decision token"
            # the training loss on this record must equal the weighted sum of these CEs
            loss, _, _, plain = loss_from_logits(logits, tgt, pos, dec, weight, dev)
            want = (ce * (1.0 + (weight - 1.0) * d.double())).sum().item()
            assert abs(loss.item() - want) <= 1e-4 * max(1.0, abs(want)), (loss.item(), want)
            assert abs(plain.item() - ce.sum().item()) <= 1e-4 * max(1.0, plain.item()), (plain.item(), ce.sum().item())
            assert weight_mass(labels, dec, 1.0)[:2] == (pos.numel(), int(d.sum()))
            n += pos.numel()
            nd += int(d.sum())
            nh += int(h.sum())
            no_hard += int(not bool(h.any()))
            ce_all += ce.sum().item()
            ce_dec += ce[d].sum().item()
            ce_hard += ce[h].sum().item()
    log("DRY-RUN forward pass ok on %d records: loss all %.4f, decision %.4f, hard %.4f, other %.4f "
        "(untrained or given model)" % (len(data), ce_all / n, ce_dec / max(nd, 1), ce_hard / max(nh, 1),
                                        (ce_all - ce_dec) / max(n - nd, 1)))
    log("DRY-RUN hard tokens: %d of %d label tokens (%.1f%%), %.1f%% of the decision tokens; %d of %d records have none"
        % (nh, n, 100 * nh / n, 100 * nh / max(nd, 1), no_hard, len(data)))
    for w in sorted({1.0, 3.0, 5.0, 8.0, weight, RECOMMENDED_W}):
        mass = (n - nd) + w * nd
        lmass = (ce_all - ce_dec) + w * ce_dec
        log("DRY-RUN W=%-4g decision tokens %.1f%% of label tokens, %.1f%% of weight mass, %.1f%% of weighted loss; "
            "hard tokens %.1f%% of label tokens, %.1f%% of weight mass, %.1f%% of weighted loss%s%s"
            % (w, 100 * nd / n, 100 * w * nd / mass, 100 * w * ce_dec / lmass, 100 * nh / n, 100 * w * nh / mass,
               100 * w * ce_hard / lmass, "  <- chosen" if w == weight else "",
               "  <- recommended" if w == RECOMMENDED_W else ""))
    log("DRY-RUN recommended launch: python train.py --train TRAIN --val VAL --out OUT --decision-weight %g%s"
        % (RECOMMENDED_W, launch_flags))



def launch_flags(a) -> str:
    """The decision / hard flags this run was given (others stay at their defaults), for the dry-run's launch line."""
    keys = ("decision_labels", "decision_ref_labels", "decision_params", "decision_skip_params",
            "hard_labels", "hard_ref_labels", "hard_params", "hard_ref_params", "hard_param_names",
            "hard_ref_sigil")
    return "".join(" --%s %s" % (k.replace("_", "-"), getattr(a, k) or "''") for k in keys if getattr(a, k) is not None)


def save(model, tok, out, tag, meta):
    if RANK != 0:
        return
    d = Path(out) / tag
    t = time.time()
    peft_model = model if hasattr(model, "merge_adapter") else None
    if peft_model is not None:  # merge in place, save plain weights, then unmerge and keep training
        peft_model.merge_adapter()
        model = peft_model.get_base_model()
        sd = {k.replace(".base_layer.", "."): v.detach().to(torch.bfloat16)
              for k, v in model.state_dict().items() if "lora_" not in k}
    else:
        sd = {k: v.detach().to(torch.bfloat16) for k, v in model.state_dict().items()}
    if model.get_output_embeddings().weight is model.get_input_embeddings().weight:
        # tied: the bf16 copies are separate tensors, so save_pretrained would write the
        # 248k x 1024 matrix twice (+0.5 GB); the config re-ties lm_head on load
        sd = {k: v for k, v in sd.items() if not k.startswith("lm_head.")}
    model.save_pretrained(d, state_dict=sd, safe_serialization=True)
    tok.save_pretrained(d)
    if peft_model is not None:
        peft_model.unmerge_adapter()
    (d / "train_meta.json").write_text(json.dumps(meta, indent=1))
    log("SAVED %s in %.0fs" % (d, time.time() - t))


# ---- resume checkpoints -------------------------------------------------------------------------
RESUME_PREFIX = "resume-step-"
RESUME_KEEP = 2
FP_ARGS = ("bs", "lr", "warmup", "min_lr", "max_len", "seed", "embed", "lora", "decision_weight", "n", "epochs",
           "tf32", "autocast")  # the precision changes the numbers: a resume must not switch it mid-run
# what a checkpoint written before these flags existed ran with (pure fp32, TF32 off)
FP_LEGACY = {"tf32": False, "autocast": "none"}


def _fsync_path(p):
    fd = os.open(str(p), os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def resume_complete(d):
    """The step of a complete resume checkpoint directory, else None. Complete = the COMPLETE marker (written
    last, before the rename) is there and the state file has the size it recorded; a temp dir, a half-copied
    one or a truncated state file is not."""
    try:
        m = json.loads((Path(d) / "COMPLETE").read_text())
        if (Path(d) / "state.pt").stat().st_size != m["state_bytes"]:
            return None
        return int(m["step"])
    except (OSError, ValueError, KeyError, TypeError):
        return None


def list_resume(root):
    """[(step, dir)] of the complete resume checkpoints under `root`, oldest first."""
    root = Path(root)
    found = []
    for d in root.glob(RESUME_PREFIX + "*") if root.is_dir() else ():
        step = resume_complete(d) if d.is_dir() else None
        if step is not None:
            found.append((step, d))
    return sorted(found)


def find_resume(path):
    """The newest complete resume checkpoint: `path` itself if it is one, else the newest inside it."""
    if resume_complete(path) is not None:
        return Path(path)
    found = list_resume(path)
    return found[-1][1] if found else None


def save_resume(out, step, state, keep=RESUME_KEEP):
    """Atomically write `state` as out/resume-step-NNNNNN/ (state.pt + COMPLETE + info.json): temp dir ->
    fsync every file and the dir -> rename -> fsync the parent; then delete all but the latest `keep`
    complete ones. Returns (dir, bytes, seconds)."""
    t = time.time()
    root = Path(out)
    root.mkdir(parents=True, exist_ok=True)
    for stale in root.glob(".tmp-" + RESUME_PREFIX + "*"):  # a crashed earlier save: never loadable, only disk
        shutil.rmtree(stale, ignore_errors=True)
    final = root / ("%s%06d" % (RESUME_PREFIX, step))
    if resume_complete(final) == step:
        return final, (final / "state.pt").stat().st_size, 0.0
    tmp = root / (".tmp-%s%06d-%d" % (RESUME_PREFIX, step, os.getpid()))
    tmp.mkdir()
    with open(tmp / "state.pt", "wb") as f:
        torch.save(state, f)
        f.flush()
        os.fsync(f.fileno())
    nbytes = (tmp / "state.pt").stat().st_size
    info = {"step": step, "epoch": state["epoch"], "state_bytes": nbytes, "version": 1, "time": time.time(),
            "torch": torch.__version__}
    for name in ("info.json", "COMPLETE"):  # the marker last
        with open(tmp / name, "w") as f:
            f.write(json.dumps(info))
            f.flush()
            os.fsync(f.fileno())
    _fsync_path(tmp)
    if final.exists():  # an incomplete one of the same name (never a complete one, handled above)
        shutil.rmtree(final)
    os.rename(tmp, final)
    _fsync_path(root)
    for _, old in list_resume(root)[:-keep]:
        (old / "COMPLETE").unlink()  # first: a half-deleted checkpoint must not look complete
        _fsync_path(old)
        shutil.rmtree(old, ignore_errors=True)
    return final, nbytes, time.time() - t


def load_resume(path):
    return torch.load(Path(path) / "state.pt", map_location="cpu", mmap=True, weights_only=True)


def epoch_order(n, seed, epoch):
    """The example order of one epoch. A pure function of (seed, epoch): epoch 0 is exactly the old
    `random.Random(seed).shuffle(data)`, and a resume recomputes it instead of storing it."""
    idx = list(range(n))
    random.Random(seed + epoch).shuffle(idx)
    return idx


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Qwen/Qwen3.5-0.8B")
    ap.add_argument("--train", required=True)
    ap.add_argument("--val")
    ap.add_argument("--tools", help="tools.json when examples carry none (nativetools export)")
    ap.add_argument("--out", help="checkpoint folder (required unless --dry-run)")
    ap.add_argument("--bs", type=int, default=16, help="examples per optimizer step (global)")
    ap.add_argument("--lr", type=float, default=2e-5)
    ap.add_argument("--warmup", type=float, default=0.03, help="fraction of steps")
    ap.add_argument("--min-lr", type=float, default=0.1, help="final lr as a fraction of --lr")
    ap.add_argument("--max-len", type=int, default=8192, help="the Data agent's cap (data/gen.py MAX_LEN)")
    ap.add_argument("--hours", type=float, default=8.0, help="hard wall-clock budget for training")
    ap.add_argument("--decision-weight", type=float, default=1.0, metavar="W",
                    help="CE weight on decision tokens (fmt.py); 1.0 = plain mean CE, bit-identical to before. "
                    "The batch is normalised by its weight mass")
    ap.add_argument("--decision-labels", help="think slot labels whose values are decisions, comma list "
                    "(default: fmt.DEFAULT_LABELS = the current and the v2 labels)")
    ap.add_argument("--decision-ref-labels", help="labels of those whose value counts only by its row refs "
                    "(default saw,last; empty = none)")
    ap.add_argument("--decision-params", help="call parameters whose values are decisions (default * = all)")
    ap.add_argument("--decision-skip-params", help="call parameters never decisions (default question)")
    ap.add_argument("--hard-labels", help="think slot labels whose whole value is a hard token (default "
                    "fmt.HARD_LABELS; empty = none)")
    ap.add_argument("--hard-ref-labels", help="labels whose hard tokens are only their row refs (default "
                    "fmt.HARD_REF_LABELS = last; saw,last adds the seen rows; empty = none)")
    ap.add_argument("--hard-params", help="call parameters whose values (and names) are hard tokens (default "
                    "fmt.HARD_PARAMS; empty = none)")
    ap.add_argument("--hard-ref-params", help="call parameters whose hard tokens are only their row refs and date "
                    "leaves (default fmt.HARD_REF_PARAMS = args; empty = none)")
    ap.add_argument("--hard-param-names", type=int, choices=(0, 1), help="1 = the names of the hard parameters a "
                    "call sets are hard tokens too (default 0)")
    ap.add_argument("--hard-ref-sigil", type=int, choices=(0, 1), help="1 = the # / @ of a ref in a ref label is "
                    "hard too (default 0: only the row number)")
    ap.add_argument("--train-eval-n", type=int, default=300, help="train records (a fixed sample) scored in "
                    "eval mode at each eval, for the train side of the decision-token report")
    ap.add_argument("--test", help="test file: scored (all and decision tokens) at the last eval only; "
                    "not opened otherwise")
    ap.add_argument("--dry-run", type=int, default=0, metavar="N", help="tokenizer, mask assertions and one "
                    "forward pass over N train records, no training; prints the decision-token shares")
    ap.add_argument("--embed", choices=["freeze", "train"], default="freeze")
    ap.add_argument("--val-n", type=int, default=400, help="val examples scored at each checkpoint")
    ap.add_argument("--n", type=int, default=0, help="use only the first N train examples")
    ap.add_argument("--max-steps", type=int, default=0, help="stop after N steps (smoke)")
    ap.add_argument("--checkpoints", default="0.25,0.5,1.0")
    ap.add_argument("--log-every", type=int, default=5)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--grad-ckpt", dest="grad_ckpt", action="store_true", help="gradient checkpointing (off by "
                    "default: ~25%% faster, more memory; the memory probe switches it on by itself on an OOM)")
    ap.add_argument("--no-grad-ckpt", dest="grad_ckpt", action="store_false", help="the default; kept so old "
                    "command lines still work")
    ap.set_defaults(grad_ckpt=False)
    ap.add_argument("--tf32", action=argparse.BooleanOptionalAction, default=True, help="TF32 matmuls "
                    "(default on; --no-tf32 = full-precision fp32 matmuls, the legacy behaviour)")
    ap.add_argument("--autocast", choices=("auto", "bf16", "none"), default="auto", help="bf16 autocast of the "
                    "forward/backward over fp32 master weights, fp32 optimizer state and fp32 lm_head + loss. auto "
                    "(default) = bf16 on a CUDA GPU with bf16, none on CPU; none = the legacy pure-fp32 path")
    ap.add_argument("--fused-adam", action=argparse.BooleanOptionalAction, default=True, help="fused AdamW on "
                    "CUDA (default on; falls back to the plain one where unavailable; --no-fused-adam = plain)")
    ap.add_argument("--epochs", type=int, default=1, help="passes over the train file, a fresh shuffle each "
                    "(epoch 0 = the single-epoch order of before)")
    ap.add_argument("--save-every", type=int, default=0, metavar="N", help="write a resume checkpoint "
                    "(out/resume-step-NNNNNN/, the latest two kept) every N steps; 0 = none")
    ap.add_argument("--resume", nargs="?", const="auto", metavar="PATH", help="continue from the newest complete resume "
                    "checkpoint in --out (or PATH: a checkpoint or a folder of them); none = start fresh")
    ap.add_argument("--term-grace", type=float, default=30.0, help="seconds from SIGTERM within which the "
                    "resume checkpoint must be done (GCP Spot gives ~30); skipped if the last one took longer")
    ap.add_argument("--lora", type=int, default=0, help="LoRA rank on every language-model linear layer "
                    "(0 = full fine-tune); for models whose fp32 AdamW state does not fit a T4, e.g. Qwen3.5-2B")
    a = ap.parse_args()
    if not a.out and not a.dry_run:
        ap.error("--out is required (except with --dry-run)")
    if a.save_every < 0 or a.epochs < 1:
        ap.error("--save-every must be >= 0 and --epochs >= 1")
    if a.resume and not a.dry_run and (Path(a.out) / "DONE").exists():
        log("RESUME: %s/DONE exists, the run already finished; nothing to do" % a.out)
        return

    a.autocast_explicit = a.autocast == "bf16"  # an explicit bf16 that fails is an error; the default falls back
    a.autocast = resolve_autocast(a.autocast)  # recorded (meta, resume fingerprint) as what actually ran
    t_start = time.time()
    deadline = t_start + a.hours * 3600
    if WORLD > 1:
        torch.distributed.init_process_group("nccl")
        torch.cuda.set_device(int(os.environ["LOCAL_RANK"]))
    dev = torch.device("cuda", torch.cuda.current_device()) if torch.cuda.is_available() else torch.device("cpu")
    torch.manual_seed(a.seed)

    from transformers import AutoModelForCausalLM, AutoTokenizer
    tok = AutoTokenizer.from_pretrained(a.model)
    default_tools = json.loads(Path(a.tools).read_text()) if a.tools else None
    W = a.decision_weight
    assert W > 0, "--decision-weight must be positive"
    hard = fmt.HardConfig.parse(a.hard_labels, a.hard_ref_labels, a.hard_params, a.hard_ref_params,
                              param_names=a.hard_param_names, ref_sigil=a.hard_ref_sigil)
    cfg = fmt.DecisionConfig.parse(a.decision_labels, a.decision_ref_labels, a.decision_params,
                                   a.decision_skip_params, hard=hard)
    log("decision config: W %g %s" % (W, cfg))
    assert_mask_sample(tok, a.train, default_tools, cfg)
    data = load(tok, a.train, a.max_len, a.dry_run or a.n, default_tools, 64, "train", cfg)
    vdata = [] if a.dry_run else load(tok, a.val, a.max_len, a.val_n, default_tools, 16, "val", cfg) if a.val else []

    model = AutoModelForCausalLM.from_pretrained(a.model, dtype=torch.float32).to(dev)
    model.config.use_cache = False
    if a.tf32:
        torch.set_float32_matmul_precision("high")  # cudnn's TF32 (convs) is on by default in torch
    else:
        torch.set_float32_matmul_precision("highest")
        torch.backends.cuda.matmul.allow_tf32 = False
    AMP["dtype"] = torch.bfloat16 if a.autocast == "bf16" else None
    log("precision: tf32 %s autocast %s grad-ckpt %s fused-adam %s" % (a.tf32, a.autocast, a.grad_ckpt, a.fused_adam))
    if a.dry_run:
        dry_run(model, data, dev, W, launch_flags(a))
        log("DRY-RUN done: no training step was taken")
        if WORLD > 1:
            torch.distributed.destroy_process_group()
        return
    emb = model.get_input_embeddings().weight
    tied = model.get_output_embeddings().weight is emb
    if a.embed == "freeze":
        emb.requires_grad_(False)
        if not tied:
            model.get_output_embeddings().weight.requires_grad_(False)
    if a.lora:
        # the base stays frozen in fp32; checkpoints merge the adapters back (save), so the
        # eval arms load a plain model exactly as they do after a full fine-tune
        from peft import LoraConfig, get_peft_model
        model = get_peft_model(model, LoraConfig(r=a.lora, lora_alpha=2 * a.lora, lora_dropout=0.0,
                                                 target_modules="all-linear", exclude_modules=r".*visual.*"))
    params = [p for p in model.parameters() if p.requires_grad]
    def enable_ckpt():
        model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    if a.grad_ckpt:
        enable_ckpt()
    model.train()
    if AMP["dtype"] is not None and data:
        if not amp_smoke(model, data, dev, W, explicit=a.autocast_explicit):
            a.autocast = "none"  # recorded as what ran
    cap = probe_memory(model, data, dev, sum(p.numel() for p in params), W, enable_ckpt=None if a.grad_ckpt else enable_ckpt)
    if cap is not None:
        keep = [d for d in data if len(d[0]) <= cap]
        log("MEMORY cap %d tokens: dropped %d of %d examples" % (cap, len(data) - len(keep), len(data)))
        data, vdata = keep, [d for d in vdata if len(d[0]) <= cap]
    # a fixed sample of the train records, scored in eval mode next to val (before the shuffle)
    tsample = [data[i] for i in sorted(random.Random(1234).sample(range(len(data)), min(a.train_eval_n, len(data))))]
    n_train = sum(p.numel() for p in params)
    log("model %s params %d trainable %d (embed %s, tied %s) dev %s world %d"
        % (type(model).__name__, sum(p.numel() for p in model.parameters()), n_train, a.embed, tied, dev, WORLD))
    try:
        opt = torch.optim.AdamW(params, lr=a.lr, weight_decay=0.0, betas=(0.9, 0.95),
                                fused=a.fused_adam and dev.type == "cuda")
    except (RuntimeError, TypeError):
        opt = torch.optim.AdamW(params, lr=a.lr, weight_decay=0.0, betas=(0.9, 0.95))

    spe = len(data) // a.bs  # steps per epoch (a partial last batch is dropped, as before)
    steps = spe * a.epochs
    if a.max_steps:
        steps = min(steps, a.max_steps)
    assert steps > 0, "fewer examples than one batch"
    warm = max(1, int(a.warmup * steps))

    def lr_at(s):  # s = 0-based step index
        if s < warm:
            return (s + 1) / warm
        frac = (s - warm) / max(1, steps - warm)
        return a.min_lr + (1 - a.min_lr) * (1 - frac)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lr_at)
    marks = {max(1, math.ceil(float(f) * steps)): "ckpt-%03d" % round(float(f) * 100) for f in a.checkpoints.split(",")}
    marks.setdefault(steps, "ckpt-100")  # the end of the epoch is always saved
    log("steps %d bs %d warmup %d lr %g checkpoints %s budget %.2fh" % (steps, a.bs, warm, a.lr, marks, a.hours))

    meta = {"args": vars(a), "steps": steps, "examples": len(data), "decision_config": repr(cfg),
            "hard_config": repr(cfg.hard), "hard_note": "hn/hloss/hacc in train/val/test: the hard tier, a subset of dn"}

    def eval_all(step):
        """Train sample and val: loss and accuracy on all label tokens and on decision tokens only."""
        for tag, key, ds in (("TRAIN", "train", tsample), ("VAL", "val", vdata)):
            if ds:
                r = evaluate(model, ds, dev)
                report(tag, step, r)
                meta.setdefault(key, []).append(dict(r, step=step))

    def eval_test(step, tag):
        """The test file, read only here, after the last checkpoint is saved (so a bad file cannot cost it)."""
        tdata = load(tok, a.test, a.max_len, 0, default_tools, 16, "test", cfg)
        if cap is not None:
            tdata = [d for d in tdata if len(d[0]) <= cap]
        r = evaluate(model, tdata, dev)
        report("TEST", step, r)
        meta["test"] = [dict(r, step=step)]
        if RANK == 0:
            (Path(a.out) / tag / "train_meta.json").write_text(json.dumps(meta, indent=1))
    tok_all = tok_lab = 0
    start = 0
    truncated = False
    t0 = time.time()
    win = [0.0, 0, 0, time.time()]  # loss sum, label tokens, all tokens, window start
    out_dir = Path(a.out) if a.out else None
    named = {n: p for n, p in model.named_parameters() if p.requires_grad}
    fp = {"args": {k: getattr(a, k) for k in FP_ARGS}, "steps": steps, "spe": spe, "examples": len(data),
          "cfg": repr(cfg), "order": hashlib.sha1(json.dumps(epoch_order(len(data), a.seed, 0)).encode()).hexdigest(),
          "params": hashlib.sha1(json.dumps([(n, list(p.shape)) for n, p in named.items()]).encode()).hexdigest()}
    ck = find_resume(a.out if a.resume == "auto" else a.resume) if a.resume else None
    if a.save_every and not ck and list_resume(out_dir):
        raise SystemExit("%s holds resume checkpoints (%s) but this run does not resume: pass --resume to continue "
                         "from them, or remove them" % (out_dir, ", ".join(d.name for _, d in list_resume(out_dir))))
    if a.resume and not ck:
        log("RESUME: no complete resume checkpoint in %s; starting fresh" % (a.out if a.resume == "auto" else a.resume))
    if ck:
        st0 = load_resume(ck)
        ckfp = dict(st0["fingerprint"], args={**FP_LEGACY, **st0["fingerprint"]["args"]})  # old checkpoints: legacy precision
        diff = [k for k in fp if fp[k] != ckfp.get(k)]
        if diff:
            raise SystemExit("RESUME: %s was made by a different run (%s differ: have %s, checkpoint %s); fix the flags "
                             "or remove it (a precision change: pass --no-tf32 --autocast none to continue a checkpoint made "
                             "before the precision flags existed)" % (ck, ", ".join(diff), {k: fp[k] for k in diff},
                                               {k: ckfp.get(k) for k in diff}))
        with torch.no_grad():
            for n, p in named.items():
                p.copy_(st0["params"][n])
        opt.load_state_dict(st0["opt"])
        sched.load_state_dict(st0["sched"])
        random.setstate((st0["rng"]["python"][0], tuple(st0["rng"]["python"][1]), st0["rng"]["python"][2]))
        torch.set_rng_state(st0["rng"]["torch"])
        if st0["rng"]["cuda"] and dev.type == "cuda":
            torch.cuda.set_rng_state_all(st0["rng"]["cuda"])
        start, m = st0["step"], st0["meters"]
        tok_all, tok_lab = m["tok_all"], m["tok_lab"]
        win = [m["win"][0], m["win"][1], m["win"][2], time.time() - m["win_age"]]
        t0 = time.time() - m["elapsed"]
        deadline = time.time() + a.hours * 3600 - m["elapsed"]  # the budget is training time, across preemptions
        meta.update(st0["meta_hist"])
        log("RESUMED from %s: step %d/%d (epoch %d, example %d of %d), %.0fs of training already done, %d eval "
            "entries restored; the next step is %d" % (ck, start, steps, st0["epoch"], st0["pos"], len(data),
                                                      m["elapsed"],
                                                      sum(len(v) for v in st0["meta_hist"].values()), start + 1))
        del st0
    else:
        eval_all(0)
    if RANK == 0 and a.out:
        for mark in ("PREEMPTED", "DONE"):
            (Path(a.out) / mark).unlink(missing_ok=True)
    term = {"at": None}
    prev_handler = None
    if a.save_every or a.resume:  # otherwise SIGTERM keeps killing the process, as before
        prev_handler = signal.signal(signal.SIGTERM, lambda *_: term.update(at=term["at"] or time.time()))
    last_save_s, last_saved, preempted = 0.0, start, False

    def resume_state(st):
        return {"version": 1, "step": st, "epoch": st // spe, "pos": (st % spe) * a.bs, "seed": a.seed,
                "fingerprint": fp, "params": {n: p.detach() for n, p in named.items()},
                "opt": opt.state_dict(), "sched": sched.state_dict(),
                "rng": {"python": random.getstate(), "torch": torch.get_rng_state(),
                        "cuda": torch.cuda.get_rng_state_all() if dev.type == "cuda" else []},
                "meters": {"tok_all": tok_all, "tok_lab": tok_lab, "win": win[:3], "win_age": time.time() - win[3],
                           "elapsed": time.time() - t0},
                "meta_hist": {k: meta[k] for k in ("train", "val", "test") if k in meta}}

    def write_resume(st, why):
        nonlocal last_save_s, last_saved
        if RANK == 0:
            d, nbytes, secs = save_resume(a.out, st, resume_state(st))
            last_save_s = secs
            log("RESUME-CKPT %s at step %d/%d -> %s (%.2f GiB in %.1fs); kept %s"
                % (why, st, steps, d.name, nbytes / 2**30, secs, [x.name for _, x in list_resume(a.out)]))
        last_saved = st
        if WORLD > 1:
            torch.distributed.barrier()

    st = start
    cur_epoch, order = -1, None
    for s in range(start, steps):
        if s // spe != cur_epoch:
            cur_epoch = s // spe
            order = epoch_order(len(data), a.seed, cur_epoch)
        k = s % spe
        batch = [data[i] for i in order[k * a.bs:(k + 1) * a.bs]]
        n_lab = sum(sum(1 for y in l[1:] if y != fmt.IGNORE) for _, l, _ in batch)
        # the weight mass of the batch: n_lab at W = 1 (the old normaliser), else decisions count W each
        mass = sum(weight_mass(l, dc, W)[2] for _, l, dc in batch)
        step_loss = torch.zeros((), dtype=torch.float64, device=dev)  # summed on the device: one sync per step
        for ids, labels, dec in batch[RANK::WORLD]:
            loss, n, _, plain = forward_loss(model, ids, labels, dev, dec, W)
            (loss / (n_lab if W == 1.0 else mass)).backward()
            step_loss += plain.double()
            win[2] += len(ids)
        win[0] += step_loss.item()
        win[1] += n_lab
        if WORLD > 1:
            for p in params:
                if p.grad is not None:
                    torch.distributed.all_reduce(p.grad)
        gnorm = torch.nn.utils.clip_grad_norm_(params, 1.0)
        opt.step()
        sched.step()
        opt.zero_grad(set_to_none=True)
        tok_all += sum(len(x) for x, _, _ in batch)
        tok_lab += n_lab
        st = s + 1
        if st % a.log_every == 0 or st == steps:
            dt = time.time() - win[3]
            stats = torch.tensor([win[0], win[2]], dtype=torch.float64, device=dev)
            if WORLD > 1:
                torch.distributed.all_reduce(stats)
            mem = torch.cuda.max_memory_allocated(dev) / 2**30 if dev.type == "cuda" else 0.0
            log("step %d/%d loss %.4f gnorm %.2f lr %.2e tok/s %.0f (label %.0f) elapsed %.0fs peak %.1fGiB"
                % (st, steps, stats[0].item() / max(win[1], 1), gnorm.item(), sched.get_last_lr()[0],
                   stats[1].item() / dt, win[1] / dt, time.time() - t0, mem))
            win = [0.0, 0, 0, time.time()]
        flags = torch.tensor([float(time.time() > deadline), float(term["at"] is not None)], device=dev)
        if WORLD > 1:
            torch.distributed.all_reduce(flags)
        over, stop = flags[0].item() > 0, flags[1].item() > 0
        if over and st < steps:
            truncated = True
            log("TRUNCATED at step %d/%d: the %.2fh budget is spent" % (st, steps, a.hours))
        if st in marks or truncated:
            tag = marks.get(st, "ckpt-final")
            meta.update(step=st, truncated=truncated, tokens=tok_all, label_tokens=tok_lab,
                        train_seconds=time.time() - t0, tokens_per_s=tok_all / (time.time() - t0))
            eval_all(st)
            save(model, tok, a.out, tag, meta)
            if a.test and (truncated or st == steps):
                eval_test(st, tag)
            if truncated:
                break
        if a.save_every and st % a.save_every == 0 and st < steps and not stop:
            write_resume(st, "periodic")
        if stop and st < steps and not truncated:  # preempted: save if the notice leaves the time, then leave
            waited = time.time() - (term["at"] or time.time())
            if last_saved != st and waited + last_save_s > a.term_grace:
                log("SIGTERM: %.1fs gone and a save takes ~%.1fs, over the %.0fs grace: not saving; a resume "
                    "starts from step %d" % (waited, last_save_s, a.term_grace, last_saved))
            elif last_saved != st:
                write_resume(st, "SIGTERM")
            preempted = True
            break
    if prev_handler is not None:
        signal.signal(signal.SIGTERM, prev_handler)
    if preempted:
        if RANK == 0:
            (Path(a.out) / "train_meta.json").write_text(json.dumps(dict(meta, step=st, preempted=True), indent=1))
            (Path(a.out) / "PREEMPTED").write_text(json.dumps({"step": st, "steps": steps, "resume_step": last_saved}))
        log("PREEMPTED at step %d/%d: resume checkpoint at step %d; re-run the same command with --resume"
            % (st, steps, last_saved))
        if WORLD > 1:
            torch.distributed.destroy_process_group()
        return
    if RANK == 0:
        final = "ckpt-final" if truncated else marks[steps]
        (Path(a.out) / "FINAL").write_text(final + "\n")
        (Path(a.out) / "train_meta.json").write_text(json.dumps(meta, indent=1))
        (Path(a.out) / "DONE").write_text(json.dumps({"steps": st, "truncated": truncated, "final": final}))
    log("DONE %d steps, %d tokens in %.0fs (%.0f tok/s)%s" % (st, tok_all, time.time() - t0,
        tok_all / max(time.time() - t0, 1e-9), " TRUNCATED" if truncated else ""))
    if WORLD > 1:
        torch.distributed.destroy_process_group()


if __name__ == "__main__":
    main()
