"""Chat-format fine-tune (v4/SPEC.md section 2): Granite's own chat template,
loss on every assistant message and its end-of-turn token, nothing else.

    ft_chat.py train --model M --data sessions.jsonl --out D
                     [--bs 8 --lr 1e-4 --epochs 1 --max-pairs 4
                      --ckpt-at 2000,4000 --val heldout_sessions.jsonl]
    ft_chat.py val   --ckpt D --val heldout_sessions.jsonl

A session row is {"id", "today", "messages": [system, user, assistant, ...]}.

WINDOWING is the one place training and inference could silently disagree, so
both use `context()` below: the model sees the system message plus at most
`max_pairs` user/assistant pairs COUNTING THE CURRENT ONE (i.e. at most
max_pairs-1 prior pairs, then the current user message). A session of P pairs
becomes: one window over pairs [0, min(P, M)) with loss on every assistant in
it (each of those sees exactly the history inference sends), then for every
k >= M one window over pairs [k-M+1, k] with loss on its LAST assistant only.

`--ckpt-at` counts training examples (windows) seen, like ft_granite.py's rows.
Optimizer and schedule are ft_granite.py's: AdamW (wd 0), warmup 30 steps,
linear decay to 0.05, grad clip 1.0.
"""
import argparse, json, os, random, sys, time

MAX_PAIRS = 4


def strip_vault(content):
    return content.split("\nvault: ", 1)[0]


def context(system, pairs, user, max_pairs=MAX_PAIRS):
    """The message list sent for a turn: system, the last (max_pairs-1)
    completed (user, assistant) pairs, then the current user message.
    Shared verbatim with eval_chat.py."""
    keep = pairs[len(pairs) - (max_pairs - 1):] if max_pairs > 1 else []
    msgs = [{"role": "system", "content": system}]
    for u, a in keep:
        # SPEC 5.2: only the CURRENT user message carries its vault line;
        # history replays the raw request (keeps prompts short).
        msgs += [{"role": "user", "content": strip_vault(u)},
                 {"role": "assistant", "content": a}]
    msgs.append({"role": "user", "content": user})
    return msgs


def split_pairs(messages):
    assert messages[0]["role"] == "system", "first message must be system"
    rest = messages[1:]
    assert len(rest) % 2 == 0, "messages must alternate user/assistant"
    pairs = []
    for i in range(0, len(rest), 2):
        assert rest[i]["role"] == "user" and rest[i + 1]["role"] == "assistant"
        pairs.append((rest[i]["content"], rest[i + 1]["content"]))
    return messages[0]["content"], pairs


def windows(session, max_pairs):
    """-> [(messages, train_flags)] where train_flags[j] says whether the j-th
    assistant message in `messages` carries loss."""
    system, pairs = split_pairs(session["messages"])
    # One window per assistant turn: history user messages lose their vault
    # line (SPEC 5.2), so a turn is only ever trained with the exact prompt
    # inference sends for it.
    out = []
    for k in range(len(pairs)):
        msgs = context(system, pairs[:k], pairs[k][0], max_pairs)
        msgs.append({"role": "assistant", "content": pairs[k][1]})
        out.append((msgs, [False] * (len(msgs) // 2 - 1) + [True]))
    return out


# Qwen3.5's template renders an assistant message AFTER the last user message
# as "<think>\n\n</think>\n\n" + content and one BEFORE it as bare content, so
# the moment a session's next user message arrives, every earlier call's
# rendering changes: the whole-session training render would disagree with the
# prompt each call was generated from (and encode's prefix assertion fails).
# Rendering the empty think block on EVERY assistant message makes the template
# prefix-stable and keeps Qwen's own non-thinking generation prompt verbatim
# (enable_thinking stays off: the prompt ends "<think>\n\n</think>\n\n").
_QWEN_THINK_GATE = "loop.index0 > ns.last_query_index"


def prepare_tokenizer(tok):
    """Make the tokenizer's chat template prefix-stable over a multi-turn tool
    session. A no-op for templates without Qwen's think gate (Granite), and
    idempotent: a checkpoint saved after this carries the patched template, so
    agent.py and every scorer render exactly what training rendered."""
    t = tok.chat_template
    if isinstance(t, str) and _QWEN_THINK_GATE in t:
        assert t.count(_QWEN_THINK_GATE) == 1, "unexpected Qwen template shape"
        tok.chat_template = t.replace(_QWEN_THINK_GATE, "true")
    return tok


def traced(content):
    """A traced assistant turn opens with its own reasoning, "<think>…</think>"
    before the call. The (patched) Qwen template renders it on every assistant
    message as "<think>\nX\n</think>\n\n" + call -- never stripped, since the
    gate prepare_tokenizer removes is the only place it drops reasoning."""
    return content.lstrip().startswith("<think>") and "</think>" in content


def split_think(text):
    """Model output -> (think, call). Accepts the output with its opening tag
    ("<think>X</think> call") and without it (the generation prompt of a
    thinking run already ends "<think>\n", so the model writes "X\n</think>…").
    No "</think>": no think, the whole text is the call."""
    if "</think>" not in text:
        return "", text.strip()
    think, call = text.split("</think>", 1)
    think = think.strip()
    if think.startswith("<think>"):
        think = think[len("<think>"):].strip()
    return think, call.strip()


def join_think(think, call):
    """The assistant message content a traced turn is trained on (and replayed
    into the prompt as)."""
    return "<think>\n%s\n</think>\n\n%s" % (think, call) if think else call


def end_of_turn(tok):
    """The token that closes an assistant message: Granite's <|end_of_text|>,
    Qwen's <|im_end|> -- each tokenizer's eos_token."""
    return tok.eos_token_id


def encode(tok, msgs, flags):
    """Token ids + labels. Assistant spans are found by rendering prefixes:
    the prefix up to the turn with add_generation_prompt=True ends right before
    the content; the prefix through the turn ends with the template's
    end-of-turn token (Granite `<|end_of_text|>`, Qwen `<|im_end|>`) + "\\n" --
    content and end-of-turn carry loss, the trailing newline (and every role
    header) does not. Asserts that each prefix tokenizes to a prefix of the
    whole, so the offsets are exact. A traced turn (see `traced`) is labelled
    from after its thinking prompt's "<think>\n": its reasoning is part of the
    assistant turn. Call prepare_tokenizer(tok) first."""
    ids = list(tok.apply_chat_template(msgs, tokenize=True, return_dict=False))
    labels = [-100] * len(ids)
    eot = end_of_turn(tok)
    j = 0
    for i, m in enumerate(msgs):
        if m["role"] != "assistant":
            continue
        use = flags[j]; j += 1
        if not use:
            continue
        # a traced turn is generated from Qwen's THINKING prompt (ends
        # "<think>\n"), so its reasoning, "</think>" and the call all carry
        # loss; an untraced turn's prompt ends with the empty think block as
        # before. Granite has no think gate; the kwarg is ignored there.
        think = traced(m["content"])
        a = list(tok.apply_chat_template(msgs[:i], tokenize=True, add_generation_prompt=True,
                                         enable_thinking=think, return_dict=False))
        b = list(tok.apply_chat_template(msgs[:i + 1], tokenize=True, return_dict=False))
        assert ids[:len(a)] == a and ids[:len(b)] == b, "template not prefix-stable"
        end = len(b)
        while ids[end - 1] != eot:   # drop the template's trailing "\n"
            end -= 1
        assert end > len(a)
        labels[len(a):end] = ids[len(a):end]
    return ids, labels


def load_sessions(path):
    return [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]


def examples(tok, sessions, max_pairs, full=False):
    out = []
    for s in sessions:
        if full:
            # TOOL SESSIONS (v7): inference sends the whole conversation, calls
            # and tool results included, so one window per session with loss
            # on every assistant call — except a call marked `"loss": false`
            # (a deliberate miss a recovery trajectory shows, not teaches).
            msgs = s["messages"]
            flags = [m.get("loss", True) for m in msgs if m["role"] == "assistant"]
            out.append(encode(tok, [{"role": m["role"], "content": m["content"]} for m in msgs],
                              flags))
            continue
        for msgs, flags in windows(s, max_pairs):
            out.append(encode(tok, msgs, flags))
    return out


def show_mask(tok, ids, labels):
    print("=== rendered example; [[...]] = tokens carrying loss ===")
    buf, on = [], False
    for t, l in zip(ids, labels):
        s = tok.decode([t])
        if (l != -100) != on:
            buf.append("[[" if not on else "]]"); on = not on
        buf.append(s)
    if on:
        buf.append("]]")
    print("".join(buf))
    print("=== %d tokens, %d with loss ===" % (len(ids), sum(l != -100 for l in labels)),
          flush=True)


def plan_batches(enc, bs, rng, chunk=64):
    """Length-bucketed: shuffle, sort by length inside chunks of chunk*bs,
    cut into batches, shuffle the batches."""
    idx = list(range(len(enc)))
    rng.shuffle(idx)
    out = []
    for c in range(0, len(idx), chunk * bs):
        part = sorted(idx[c:c + chunk * bs], key=lambda i: len(enc[i][0]))
        out += [part[i:i + bs] for i in range(0, len(part), bs)]
    rng.shuffle(out)
    return out


def collate(torch, tok, enc, batch):
    L = max(len(enc[i][0]) for i in batch)
    pad = tok.pad_token_id if tok.pad_token_id is not None else tok.eos_token_id
    ids = torch.full((len(batch), L), pad)
    lab = torch.full((len(batch), L), -100)
    att = torch.zeros((len(batch), L), dtype=torch.long)
    for j, i in enumerate(batch):
        x, y = enc[i]
        ids[j, :len(x)] = torch.tensor(x)
        lab[j, :len(y)] = torch.tensor(y)
        att[j, :len(x)] = 1
    return ids, lab, att


def load(name):
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    torch.set_num_threads(4)
    tok = prepare_tokenizer(AutoTokenizer.from_pretrained(name))
    model = AutoModelForCausalLM.from_pretrained(name, dtype=torch.float32)
    model.generation_config.eos_token_id = stop_ids(tok, model)
    return tok, model.to(DEVICE(torch))


def DEVICE(torch):
    """cuda when there is one (Kaggle), else cpu; fp32 either way (T4/P100 lack bf16)"""
    return "cuda" if torch.cuda.is_available() else "cpu"


def label_loss(torch, model, ids, att, lab, reduction="mean"):
    """Next-token cross-entropy on the labelled positions only.

    The same number as `model(..., labels=lab).loss`, but the output layer is
    applied ONLY where a label is: a tool session is ~800 tokens with ~20
    carrying loss, and full-vocabulary logits (100k wide, fp32) for every
    position is what ran the trainer out of memory."""
    if hasattr(model, "get_base_model"):  # peft wrapper: adapters live inside the base modules
        model = model.get_base_model()
    hidden = model.model(input_ids=ids, attention_mask=att)[0][:, :-1]
    tgt = lab[:, 1:]
    keep = tgt != -100
    logits = model.lm_head(hidden[keep]) / getattr(model.config, "logits_scaling", 1.0)
    return torch.nn.functional.cross_entropy(logits.float(), tgt[keep], reduction=reduction)


def stop_ids(tok, model):
    """eos ids generate() must stop on. Qwen3.5-0.8B's generation_config lists only
    <|endoftext|>, not the <|im_end|> that closes a turn; set this on
    model.generation_config before saving so every consumer of the checkpoint
    stops at the end of the call."""
    e = model.generation_config.eos_token_id
    e = [] if e is None else ([e] if isinstance(e, int) else list(e))
    return sorted(set(e) | {end_of_turn(tok)})


def val_loss(torch, tok, model, path, max_pairs, bs, full=False):
    enc = examples(tok, load_sessions(path), max_pairs, full)
    model.eval()
    tot, n = 0.0, 0
    with torch.no_grad():
        for batch in plan_batches(enc, bs, random.Random(0)):
            ids, lab, att = (t.to(DEVICE(torch)) for t in collate(torch, tok, enc, batch))
            tot += label_loss(torch, model, ids, att, lab, "sum").item()
            n += (lab[:, 1:] != -100).sum().item()
    print("val %s: assistant-token loss %.4f over %d tokens (%d windows)"
          % (path, tot / max(n, 1), n, len(enc)), flush=True)
    return tot / max(n, 1)


def train(a):
    import torch
    tok, model = load(a.model)
    # the hybrid's pure-torch Mamba path (no CUDA kernels on CPU) keeps large
    # per-layer intermediates; recompute them in backward instead
    model.gradient_checkpointing_enable()
    model.config.use_cache = False
    if a.lora:
        # models too big to fine-tune whole on one 16 GB GPU: adapters on every
        # linear layer, merged back before saving (the checkpoint stays plain)
        from peft import LoraConfig, get_peft_model
        model.enable_input_require_grads()
        model = get_peft_model(model, LoraConfig(r=a.lora, lora_alpha=2 * a.lora, lora_dropout=0.05,
                                                 target_modules="all-linear", task_type="CAUSAL_LM"))
        model.print_trainable_parameters()
    sessions = load_sessions(a.data)
    enc = examples(tok, sessions, a.max_pairs, a.full)
    show_mask(tok, *max(enc[:50], key=lambda e: len(e[0])))
    rng = random.Random(a.seed)
    plan = []
    for _ in range(a.epochs):
        plan += plan_batches(enc, a.bs, rng)
    if a.max_steps:
        plan = plan[:a.max_steps]
    steps = len(plan)
    print("%d sessions -> %d windows, %d steps (bs %d, %d epochs), %d label tokens"
          % (len(sessions), len(enc), steps, a.bs, a.epochs,
             sum(sum(l != -100 for l in y) for _, y in enc)), flush=True)
    ckpts = sorted(int(x) for x in a.ckpt_at.split(",")) if a.ckpt_at else []
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=a.lr, weight_decay=0.0)
    sched = torch.optim.lr_scheduler.LambdaLR(
        opt, lambda s: min(1.0, (s + 1) / 30) * max(0.05, 1 - s / steps))
    model.train()
    seen, toks, t0, run = 0, 0, time.time(), []
    for step, batch in enumerate(plan):
        ids, lab, att = (t.to(DEVICE(torch)) for t in collate(torch, tok, enc, batch))
        loss = label_loss(torch, model, ids, att, lab)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step(); sched.step(); opt.zero_grad()
        seen += ids.shape[0]; toks += int(att.sum()); run.append(loss.item())
        if step % a.log_every == 0 or step == steps - 1:
            el = time.time() - t0
            print("step %d/%d rows %d loss %.3f  %.2fs/step  %.0f tok/s  lr %.2e"
                  % (step, steps, seen, sum(run) / len(run), el / (step + 1),
                     toks / el, sched.get_last_lr()[0]), flush=True)
            run = []
        while ckpts and seen >= ckpts[0]:
            d = "%s-%d" % (a.out, ckpts.pop(0))
            model.save_pretrained(d); tok.save_pretrained(d)
            print("saved", d, flush=True)
    if a.lora:
        model = model.merge_and_unload()
    model.save_pretrained(a.out); tok.save_pretrained(a.out)
    print("saved", a.out, "in %.0fs" % (time.time() - t0), flush=True)
    if a.val:
        val_loss(torch, tok, model, a.val, a.max_pairs, a.bs, a.full)


def val(a):
    import torch
    tok, model = load(a.ckpt)
    val_loss(torch, tok, model, a.val, a.max_pairs, a.bs)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["train", "val"])
    ap.add_argument("--model", default="ibm-granite/granite-4.0-350m")
    ap.add_argument("--data")
    ap.add_argument("--out")
    ap.add_argument("--ckpt")
    ap.add_argument("--val")
    ap.add_argument("--bs", type=int, default=8)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--epochs", type=int, default=1)
    ap.add_argument("--max-pairs", type=int, default=MAX_PAIRS)
    ap.add_argument("--max-steps", type=int, default=0, help="smoke tests only")
    ap.add_argument("--ckpt-at", default="")
    ap.add_argument("--log-every", type=int, default=10)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--lora", type=int, default=0, help="LoRA rank (0: full fine-tune)")
    ap.add_argument("--full", action="store_true",
                    help="tool sessions: one window per session, loss on every assistant call")
    a = ap.parse_args()
    {"train": train, "val": val}[a.cmd](a)
