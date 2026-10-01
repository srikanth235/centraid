"""SFT trainer for Qwen3.5-0.8B, one sequence per session (SPEC §11.3, §11.7, §11.8).

    python train.py --train train.jsonl.gz --val val.jsonl.gz --out ckpt/ [--hours 8]
    torchrun --nproc_per_node 2 train.py ...        # data parallel (Kaggle's 2x T4)

- Text from the shared renderer (../render.py, thinking kept in history); loss on every
  assistant message's think + call through `<|im_end|>`, none on system, user or tool tokens
  (fmt.py). The mask is asserted on a sample (and against the data's `loss_tokens`) first.
- Full fine-tune of every transformer layer in fp32. The tied embedding / lm_head (248k x 1024,
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
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
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


def probe_memory(model, data, dev, n_train, weight=1.0, lengths=(None, 6144, 4096)):
    """Fail fast instead of hours in: one forward + backward on the longest example (no update),
    with AdamW's two fp32 states (allocated lazily at the first step) held as ballast.
    On CUDA OOM, retry at shorter caps; returns the largest length that fit (None = all)."""
    if dev.type != "cuda" or not data:
        return None
    ballast = torch.empty(2 * n_train, dtype=torch.float32, device=dev)
    for cap in lengths:
        pool = [d for d in data if cap is None or len(d[0]) <= cap]
        ids, labels, dec = max(pool, key=lambda d: len(d[0]))
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
            model.zero_grad(set_to_none=True)
            torch.cuda.empty_cache()
            log("MEMORY probe: OOM at %d tokens" % len(ids))
    raise SystemExit("even a %d-token example does not fit" % lengths[-1])


def label_logits(model, ids, labels, dev):
    """Logits at the label positions only -> (logits fp32 [n, vocab], targets, positions)."""
    x = torch.tensor([ids], device=dev)
    y = torch.tensor(labels[1:], device=dev)
    pos = torch.nonzero(y != fmt.IGNORE).squeeze(1)
    out = model(input_ids=x, logits_to_keep=pos, use_cache=False)
    return out.logits[0].float(), y[pos], pos


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
    ap.add_argument("--no-grad-ckpt", action="store_true")
    ap.add_argument("--lora", type=int, default=0, help="LoRA rank on every language-model linear layer "
                    "(0 = full fine-tune); for models whose fp32 AdamW state does not fit a T4, e.g. Qwen3.5-2B")
    a = ap.parse_args()
    if not a.out and not a.dry_run:
        ap.error("--out is required (except with --dry-run)")

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
    if not a.no_grad_ckpt:
        model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    model.train()
    cap = probe_memory(model, data, dev, sum(p.numel() for p in params), W)
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
        opt = torch.optim.AdamW(params, lr=a.lr, weight_decay=0.0, betas=(0.9, 0.95), fused=dev.type == "cuda")
    except (RuntimeError, TypeError):
        opt = torch.optim.AdamW(params, lr=a.lr, weight_decay=0.0, betas=(0.9, 0.95))

    random.Random(a.seed).shuffle(data)
    steps = len(data) // a.bs
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
    eval_all(0)
    tok_all = tok_lab = 0
    t0 = time.time()
    win = [0.0, 0, 0, time.time()]  # loss sum, label tokens, all tokens, window start
    truncated = False
    for s in range(steps):
        batch = data[s * a.bs:(s + 1) * a.bs]
        n_lab = sum(sum(1 for y in l[1:] if y != fmt.IGNORE) for _, l, _ in batch)
        # the weight mass of the batch: n_lab at W = 1 (the old normaliser), else decisions count W each
        mass = sum(weight_mass(l, dc, W)[2] for _, l, dc in batch)
        for ids, labels, dec in batch[RANK::WORLD]:
            loss, n, _, plain = forward_loss(model, ids, labels, dev, dec, W)
            (loss / (n_lab if W == 1.0 else mass)).backward()
            win[0] += plain.item()
            win[2] += len(ids)
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
        over = torch.tensor([float(time.time() > deadline)], device=dev)
        if WORLD > 1:
            torch.distributed.all_reduce(over)
        if over.item() > 0 and st < steps:
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
    if RANK == 0:
        final = "ckpt-final" if truncated else marks[steps]
        (Path(a.out) / "FINAL").write_text(final + "\n")
        (Path(a.out) / "train_meta.json").write_text(json.dumps(meta, indent=1))
    log("DONE %d steps, %d tokens in %.0fs (%.0f tok/s)%s" % (st, tok_all, time.time() - t0,
        tok_all / max(time.time() - t0, 1e-9), " TRUNCATED" if truncated else ""))
    if WORLD > 1:
        torch.distributed.destroy_process_group()


if __name__ == "__main__":
    main()
