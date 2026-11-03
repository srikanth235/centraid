"""Generate calls for probe items in the phone's regime (DESIGN section 4).

    python3 run.py --model DIR_OR_HF_ID --items probe/dev.jsonl --out runs/x.jsonl
        [--backend hf|gguf] [--gguf FILE] [--batch 16] [--limit N] [--dtype bf16|fp32] [--device auto] [--k 8]

Greedy. Phase 1 generates up to 200 tokens and stops at `</think>`; if it did not stop (and the model did not end
its turn), "\\n</think>\\n\\n" is appended and the row is `capped`. Phase 2 continues so that the new tokens total at most
512, stopping at `</tool_call>`, EOS or `<|im_end|>`. The chat template normally ends the prompt with `<think>\\n`,
so `raw` starts inside the think; parse.py accepts both.

Output rows (JSONL, sorted keys): id, raw, think, think_tokens, capped, call, candidates, seconds. `seconds` is the
wall time of the item's batch divided by the batch size (hf) or the item's own time (gguf). `<out>.meta.json` records
model id, sha256 of local weights, args, catalog sha and items sha.

`generate_items` is the one function lab.py also calls. For the gguf backend `model` is a llama_cpp.Llama and
`tokenizer` is still the HF tokenizer (it only renders the chat template). Torch and transformers are imported lazily.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path
from typing import Any, Callable

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import parse  # noqa: E402

THINK_CAP = 200
MAX_NEW = 512
CLOSE = "\n</think>\n\n"
TURN_END = ("<|im_end|>", "<|endoftext|>")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def read_items(path: str | Path) -> list[dict]:
    return [json.loads(l) for l in Path(path).read_text(encoding="utf-8").splitlines() if l.strip()]


# ---------------------------------------------------------------- shared phase logic

def _row(item: dict, candidates: list[str], phase1: str, capped: bool, phase2: str, tokenizer: Any, seconds: float) -> dict:
    raw = phase1 + (CLOSE if capped else "") + phase2
    parsed = parse.parse_output(raw)
    think = parsed["think"]
    think_tokens = len(tokenizer.encode(think, add_special_tokens=False)) if think else 0
    return {"id": item["id"], "raw": raw, "think": think, "think_tokens": think_tokens, "capped": capped,
            "call": parsed["call"], "candidates": candidates, "seconds": round(seconds, 3)}


# ---------------------------------------------------------------- hf backend

def _eos_ids(tokenizer: Any, model: Any) -> set[int]:
    ids: set[int] = set()
    for tok in TURN_END:
        i = tokenizer.convert_tokens_to_ids(tok)
        if isinstance(i, int) and i >= 0 and i != tokenizer.unk_token_id:
            ids.add(i)
    eos = getattr(getattr(model, "generation_config", None), "eos_token_id", None)
    for i in ([eos] if isinstance(eos, int) else (eos or [])):
        ids.add(int(i))
    return ids


def _make_stopper(tokenizer: Any, prompt_len: int, stops: tuple[str, ...], eos: set[int], limits: list[int]) -> Any:
    """StoppingCriteria: per sequence, true once its decoded new text holds a stop string, it emitted EOS, or it has
    produced its own `limits[i]` new tokens."""
    import torch
    from transformers import StoppingCriteria

    class TextStop(StoppingCriteria):
        def __call__(self, input_ids: Any, scores: Any, **kwargs: Any) -> Any:
            new = input_ids[:, prompt_len:]
            texts = tokenizer.batch_decode(new, skip_special_tokens=False)
            steps = new.shape[1]
            done = [any(s in t for s in stops) or any(int(x) in eos for x in row) or steps >= lim
                    for t, row, lim in zip(texts, new.tolist(), limits)]
            return torch.tensor(done, dtype=torch.bool, device=input_ids.device)

    return TextStop()


def _hf_generate(model: Any, tokenizer: Any, prompts: list[str], limits: list[int], stops: tuple[str, ...], eos: set[int]) -> list[tuple[str, int, bool]]:
    """Greedy continuation of each prompt: (new text cut after the first stop string, new token count, ended by EOS)."""
    import torch
    from transformers import StoppingCriteriaList

    tokenizer.padding_side = "left"
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    enc = tokenizer(prompts, return_tensors="pt", padding=True, add_special_tokens=False).to(model.device)
    plen = enc["input_ids"].shape[1]
    with torch.no_grad():
        out = model.generate(**enc, max_new_tokens=max(limits), do_sample=False, temperature=None, top_p=None, top_k=None,
                             stopping_criteria=StoppingCriteriaList([_make_stopper(tokenizer, plen, stops, eos, limits)]),
                             pad_token_id=tokenizer.pad_token_id)
    results = []
    for row in out[:, plen:].tolist():
        ended = False
        for pos, tok in enumerate(row):
            if tok in eos:
                row, ended = row[:pos], True
                break
        text = tokenizer.decode(row, skip_special_tokens=False)
        cut = [text.find(s) + len(s) for s in stops if s in text]
        if cut:
            text = text[:min(cut)]
        results.append((text, len(row), ended))
    return results


def _generate_hf(model, tokenizer, items, catalog, k, batch, think_cap, max_new, progress, render) -> list[dict]:
    rendered = [render(it, catalog, tokenizer, k) for it in items]
    order = sorted(range(len(items)), key=lambda i: -len(rendered[i][0]))  # longest first: less padding, same results per row
    eos = _eos_ids(tokenizer, model)
    rows: dict[int, dict] = {}
    for start in range(0, len(order), batch):
        idx = order[start:start + batch]
        t0 = time.perf_counter()
        prompts = [rendered[i][0] for i in idx]
        p1 = _hf_generate(model, tokenizer, prompts, [think_cap] * len(prompts), ("</think>",), eos)
        phase1, capped, ended, used = [], [], [], []
        for text, n, eos_hit in p1:
            closed = "</think>" in text
            phase1.append(text)
            capped.append(not closed and not eos_hit)
            ended.append(eos_hit and not closed)
            used.append(n)
        cont = [j for j in range(len(idx)) if not ended[j]]
        phase2 = [""] * len(idx)
        if cont:
            ctx = [prompts[j] + phase1[j] + (CLOSE if capped[j] else "") for j in cont]
            p2 = _hf_generate(model, tokenizer, ctx, [max_new - used[j] for j in cont], ("</tool_call>",), eos)
            for j, (text, _n, _e) in zip(cont, p2):
                phase2[j] = text
        per = (time.perf_counter() - t0) / len(idx)
        for j, i in enumerate(idx):
            rows[i] = _row(items[i], rendered[i][1], phase1[j], capped[j], phase2[j], tokenizer, per)
        if progress:
            progress(min(start + batch, len(order)), len(order))
    return [rows[i] for i in range(len(items))]


# ---------------------------------------------------------------- gguf backend

def _gguf_stream(llm: Any, prompt: str, max_tokens: int, stops: tuple[str, ...]) -> tuple[str, int, bool]:
    """Greedy stream from llama.cpp: (text cut after the first stop string, tokens, ended by EOS)."""
    toks = llm.tokenize(prompt.encode("utf-8"), add_bos=False, special=True)
    text, n, ended = "", 0, True
    for chunk in llm.create_completion(toks, max_tokens=max_tokens, temperature=0.0, top_k=1, top_p=1.0, repeat_penalty=1.0,
                                       seed=0, stream=True):
        choice = chunk["choices"][0]
        text += choice["text"]
        n += 1
        if any(s in text for s in stops):
            ended = False
            break
        if choice.get("finish_reason") == "length":
            ended = False
        elif choice.get("finish_reason"):
            ended = True
    cut = [text.find(s) + len(s) for s in stops if s in text]
    if cut:
        text = text[:min(cut)]
    return text, n, ended


def _generate_gguf(llm, tokenizer, items, catalog, k, think_cap, max_new, progress, render) -> list[dict]:
    rows = []
    for n_done, item in enumerate(items, 1):
        prompt, cands = render(item, catalog, tokenizer, k)
        t0 = time.perf_counter()
        text1, used, eos_hit = _gguf_stream(llm, prompt, think_cap, ("</think>",))
        closed = "</think>" in text1
        capped = not closed and not eos_hit
        text2 = ""
        if closed or capped:
            ctx = prompt + text1 + (CLOSE if capped else "")
            text2, _, _ = _gguf_stream(llm, ctx, max_new - used, ("</tool_call>",))
        rows.append(_row(item, cands, text1, capped, text2, tokenizer, time.perf_counter() - t0))
        if progress:
            progress(n_done, len(items))
    return rows


# ---------------------------------------------------------------- public

def generate_items(model: Any, tokenizer: Any, items: list[dict], catalog: dict, *, backend: str = "hf", k: int = 8,
                   batch: int = 16, think_cap: int = THINK_CAP, max_new: int = MAX_NEW,
                   progress: Callable[[int, int], None] | None = None) -> list[dict]:
    """Rows (see module doc) for `items`, in order. `model` is an HF model (hf) or a llama_cpp.Llama (gguf)."""
    import prompt as prompt_mod

    if backend == "hf":
        return _generate_hf(model, tokenizer, items, catalog, k, batch, think_cap, max_new, progress, prompt_mod.render)
    if backend == "gguf":
        return _generate_gguf(model, tokenizer, items, catalog, k, think_cap, max_new, progress, prompt_mod.render)
    raise ValueError(f"backend {backend!r}: hf or gguf")


def pick_device(device: str) -> str:
    if device != "auto":
        return device
    import torch

    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def load_hf(model_id: str, dtype: str = "bf16", device: str = "auto", attn_implementation: str | None = None) -> tuple[Any, Any]:
    """(model, tokenizer), model in eval mode with gradients off."""
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    td = {"bf16": torch.bfloat16, "fp32": torch.float32}[dtype]
    extra = {"attn_implementation": attn_implementation} if attn_implementation else {}
    try:
        model = AutoModelForCausalLM.from_pretrained(model_id, dtype=td, **extra)
    except TypeError:  # transformers < 4.56 spells it torch_dtype
        model = AutoModelForCausalLM.from_pretrained(model_id, torch_dtype=td, **extra)
    model.to(pick_device(device)).eval().requires_grad_(False)
    tokenizer = AutoTokenizer.from_pretrained(model_id)
    tokenizer.padding_side = "left"
    return model, tokenizer


def weight_hashes(model_id: str, gguf: str | None) -> dict[str, str] | None:
    if gguf:
        return {Path(gguf).name: sha256_file(Path(gguf))}
    path = Path(model_id)
    if path.is_dir():
        return {p.name: sha256_file(p) for p in sorted(path.glob("*.safetensors"))}
    return None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--model", required=True, help="local directory or HF id (the tokenizer comes from here for gguf too)")
    ap.add_argument("--items", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--backend", choices=["hf", "gguf"], default="hf")
    ap.add_argument("--gguf", help="GGUF file (backend gguf)")
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--limit", type=int)
    ap.add_argument("--dtype", choices=["bf16", "fp32"], default="bf16")
    ap.add_argument("--device", default="auto")
    ap.add_argument("--k", type=int, default=8)
    ap.add_argument("--think-cap", type=int, default=THINK_CAP,
                    help="think tokens before </think> is forced (a sweep variable, not a fixed choice)")
    ap.add_argument("--max-new", type=int, default=MAX_NEW, help="new tokens in all; raised to think-cap + 312 if lower")
    args = ap.parse_args(argv)
    args.max_new = max(args.max_new, args.think_cap + 312)

    import catalog as catalog_mod

    catalog_path = HERE / "catalog" / "schemas.json"
    catalog = catalog_mod.load(str(catalog_path))
    items = read_items(args.items)
    if args.limit:
        items = items[:args.limit]
    if args.backend == "gguf":
        if not args.gguf:
            ap.error("--backend gguf needs --gguf FILE")
        from llama_cpp import Llama
        from transformers import AutoTokenizer

        model = Llama(model_path=args.gguf, n_ctx=8192, n_gpu_layers=0, seed=0, verbose=False)
        tokenizer = AutoTokenizer.from_pretrained(args.model)
    else:
        model, tokenizer = load_hf(args.model, args.dtype, args.device)
    rows = generate_items(model, tokenizer, items, catalog, backend=args.backend, k=args.k, batch=args.batch,
                          think_cap=args.think_cap, max_new=args.max_new,
                          progress=lambda d, n: print(f"{d}/{n}", file=sys.stderr, flush=True))
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("".join(json.dumps(r, sort_keys=True) + "\n" for r in rows), encoding="utf-8")
    meta = {"model": args.model, "weights_sha256": weight_hashes(args.model, args.gguf),
            "args": {k: v for k, v in sorted(vars(args).items())},
            "catalog_sha256": sha256_file(catalog_path), "items_sha256": sha256_file(Path(args.items)), "n": len(rows),
            "regime": {"think_cap": args.think_cap, "max_new": args.max_new, "greedy": True}}
    Path(str(out) + ".meta.json").write_text(json.dumps(meta, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
