"""Batched decoding for the eval driver: many sessions (threads) share one GPU.

    b = BatchedBackend(HFBackend(ckpt, ...), max_batch=32, max_wait=0.1)
    text, info = b.complete_info(prompt)     # blocks; called from any number of threads

`eval/run.py` drives one session at a time and each step is one unbatched `generate` (Python bound,
the GPU idle). Here every thread's step is a request in one queue; a worker thread takes the queued
requests (up to `max_batch`, up to a padded-token budget) after a short wait, runs them as ONE padded
`generate`, and hands each caller its own result. Two layers:

- `Batcher`: the queue logic, model free (a fake `run_batch` tests it): dynamic batch, max-wait,
  a batch also starts as soon as every active client is waiting, FIFO, results routed by request.
- `BatchedBackend`: the HF part. Prompts are the same strings `HFBackend.complete` gets (the caller
  renders them with the shared renderer); tokenization is done in the caller's thread; the per-row step logic is
  `decode._Step` itself (think guard, the rendered call, one call per message), so a row's tokens are
  those of the serial run (left padding with an attention mask; greedy equality is tested in
  test_batching.py). Rows are stopped per request: `<|im_end|>` (also forced after `</tool_call>`),
  or the request's own `max_new_tokens`. A request carries what the serial path gives `Decoder.generate`: the prompt's
  dates line (`dates` of `_Step`) and the think's given prefix. `complete_info(...,
  compile=...)` applies the session's compile op after the draw (hf_backend.compiled_message); its one retry is a second request.

Also here: `stratified_sample`, the fixed subset behind `--sample`.
"""
from __future__ import annotations

import collections
import hashlib
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


# ---- queue logic (no torch)

class _Slot:
    __slots__ = ("item", "done", "value", "error", "t")

    def __init__(self, item):
        self.item, self.done, self.value, self.error, self.t = item, threading.Event(), None, None, time.monotonic()


class Batcher:
    """Groups items submitted from many threads into batches for one worker.

    `run_batch(items) -> results` (same length, same order; an element that is an Exception
    instance fails only that caller). A raised exception fails every caller of the batch.
    `cost(item)` and `max_cost` bound a batch's padded size, `(count) * max(cost)`; the head of
    the queue is always taken, so an oversized item runs alone. The worker waits, once the queue
    is non-empty, until `min(max_batch, active)` items are queued or `max_wait` seconds passed
    (counted from the later of the head's arrival and the worker turning free), then takes
    up to `max_batch` in arrival order. `active` (see `enter`/`leave`) is how many clients can
    still submit; unset, only `max_wait` ends the wait."""

    def __init__(self, run_batch, max_batch=32, max_wait=0.1, cost=None, max_cost=None, name="batcher"):
        self.run_batch, self.max_batch, self.max_wait = run_batch, max_batch, max_wait
        self.cost, self.max_cost = cost, max_cost
        self._q: collections.deque = collections.deque()
        self._cv = threading.Condition()
        self._closed = False
        self.active = 0
        self.sizes: list[int] = []  # every batch's size, in order
        self._t = threading.Thread(target=self._loop, name=name, daemon=True)
        self._t.start()

    def enter(self):
        with self._cv:
            self.active += 1

    def leave(self):
        with self._cv:
            self.active -= 1
            self._cv.notify_all()  # the wait target dropped

    def submit(self, item):
        slot = _Slot(item)
        with self._cv:
            if self._closed:
                raise RuntimeError("batcher closed")
            self._q.append(slot)
            self._cv.notify_all()
        slot.done.wait()
        if slot.error is not None:
            raise slot.error
        return slot.value

    def close(self):
        with self._cv:
            self._closed = True
            self._cv.notify_all()
        self._t.join(timeout=5)

    def _take(self):
        with self._cv:
            free = time.monotonic()  # the worker is idle from here
            while not self._q and not self._closed:
                self._cv.wait()
            if not self._q:
                return None
            deadline = max(self._q[0].t, free) + self.max_wait
            while not self._closed:
                target = min(self.max_batch, self.active) if self.active > 0 else self.max_batch
                rem = deadline - time.monotonic()
                if len(self._q) >= target or rem <= 0:
                    break
                self._cv.wait(rem)
            batch, widest = [], 0
            while self._q and len(batch) < self.max_batch:
                c = self.cost(self._q[0].item) if self.cost else 0
                if batch and self.max_cost and (len(batch) + 1) * max(widest, c) > self.max_cost:
                    break
                widest = max(widest, c)
                batch.append(self._q.popleft())
            return batch

    def _loop(self):
        while True:
            batch = self._take()
            if batch is None:
                return
            self.sizes.append(len(batch))
            try:
                results = self.run_batch([s.item for s in batch])
                if len(results) != len(batch):
                    raise RuntimeError("run_batch returned %d results for %d items" % (len(results), len(batch)))
            except BaseException as e:  # noqa: BLE001 - every caller must wake
                for s in batch:
                    s.error = e
                    s.done.set()
                continue
            for s, r in zip(batch, results):
                if isinstance(r, BaseException):
                    s.error = r
                else:
                    s.value = r
                s.done.set()


# ---- the HF backend

class _Req:
    __slots__ = ("ids", "max_new", "sample", "dates", "prefix")

    def __init__(self, ids, max_new, sample, dates=None, prefix=""):
        self.ids, self.max_new, self.sample = ids, max_new, sample  # `ids` ends with the token ids of `prefix`
        self.dates = dates  # the prompt's dates line, as decode.Decoder.generate takes it
        self.prefix = prefix  # the think's given first lines (`retry: <slot>`)


class _BatchProc:
    """One HF logits processor for the whole batch: row i runs decode._Step's logic on its own
    slice (its prompt_len is the padded width, so `new` = its generated tokens), plus its own
    max_new_tokens. A row that already ended (`<|im_end|>`, HF pads it with im_end) is left
    alone: the serial run never asks a step about anything after `<|im_end|>`."""

    def __init__(self, steps, limits, width, im_end):
        self.steps, self.limits, self.width, self.im_end = steps, limits, width, im_end

    def __call__(self, input_ids, scores):
        import torch
        ids = input_ids.cpu()  # one device sync per step
        new_len = ids.shape[1] - self.width
        for i, st in enumerate(self.steps):
            if new_len > 0 and int(ids[i, -1]) == self.im_end:
                continue
            if new_len >= self.limits[i]:  # this request's own budget: end it here
                row = scores[i]
                row.fill_(float("-inf"))
                row[self.im_end] = 0.0
                continue
            st(ids[i:i + 1], scores[i:i + 1])
        return scores


class BatchedBackend:
    """Thread-safe drop-in for HFBackend.complete over a shared `Batcher`. Wraps an HFBackend
    (its model, tokenizer, `Decoder` and stats); do not also call the wrapped one."""

    def __init__(self, hf, max_batch=32, max_wait=0.1, max_tokens=None):
        import torch
        self.hf, self.dec, self.tok, self.model = hf, hf.dec, hf.tok, hf.model
        self.sample, self.seed = hf.sample, hf.seed
        self.device = next(self.model.parameters()).device
        self._tok_lock = threading.Lock()
        self._local = threading.local()
        self.stats = hf.stats
        self._stats_lock = threading.Lock()
        self.calls = 0
        self.oom = 0
        if max_tokens is None:  # padded prompt+new tokens per batch: KV and prefill activations
            max_tokens = 160_000 if torch.cuda.is_available() else 32_768
        self.batcher = Batcher(self._run, max_batch=max_batch, max_wait=max_wait,
                               cost=lambda r: len(r.ids) + r.max_new, max_cost=max_tokens, name="hf-batch")

    # -- client side (any thread)

    @property
    def last_info(self) -> dict:
        return getattr(self._local, "info", {})

    def enter(self):
        self.batcher.enter()

    def leave(self):
        self.batcher.leave()

    def complete(self, prompt: str, sample: bool | None = None, exclude: list[str] | None = None,
                 tries: int = 4, max_new_tokens: int | None = None, compile=None) -> str:
        return self.complete_info(prompt, max_new_tokens, sample, exclude, tries, compile)[0]

    __call__ = complete

    def complete_info(self, prompt: str, max_new_tokens: int | None = None, sample: bool | None = None,
                      exclude: list[str] | None = None, tries: int = 4, compile=None):
        """(assistant message, info): what `Decoder.complete` returns for this prompt. `sample`
        and `exclude` are HFBackend.complete's: a sampled draw that must not repeat the excluded
        calls, redrawn up to `tries` times (the last draw is returned if all collide). `compile` is
        HFBackend.complete's too: the call of the message is the runtime's compiled call, a refusal is
        redrawn once with `retry: <slot>` leading the think (another request of the batcher); `info["compile"]`
        says what happened."""
        import decode
        from hf_backend import _call_key, compiled_message
        if prompt.endswith("<|im_start|>assistant\n"):
            prompt += "<think>\n"
        assert prompt.endswith("<|im_start|>assistant\n<think>\n"), prompt[-60:]
        dates = decode.fmt.dates_line_in_prompt(prompt)
        with self._tok_lock:
            ids = self.tok(prompt, add_special_tokens=False)["input_ids"]
        limit = self.dec.max_new_tokens if max_new_tokens is None else max_new_tokens
        do_sample = self.sample if sample is None else sample
        banned = {_call_key(c) for c in exclude or []}

        def draw(prefix: str = "", only_once: bool = False):
            pre = []
            if prefix:
                with self._tok_lock:
                    pre = self.tok(prefix, add_special_tokens=False)["input_ids"]
            for _ in range(1 if only_once else max(1, tries) if banned else 1):
                text, info = self.batcher.submit(_Req(ids + pre, limit, do_sample, dates, prefix))
                if only_once or not banned or _call_key(text) not in banned:
                    break
            return text, info

        text, info = draw()
        if compile is not None:
            first = info
            text, how = compiled_message(text, compile, lambda prefix: draw(prefix, True)[0])
            info = dict(first, compile=how)
            with self._stats_lock:
                self.stats["compiled"] += how in ("compiled", "retry")
                self.stats["retried"] += how in ("retry", "retry-fallback")
                self.stats["retry_ok"] += how == "retry"
                self.stats["fallback"] += how in ("fallback", "retry-fallback")
        self._local.info = info
        return text, info

    def close(self):
        self.batcher.close()

    # -- worker side (one thread)

    def _run(self, reqs):
        """Greedy rows in one generate, sampled rows (loop-breaker redraws) in another. A CUDA
        out-of-memory splits the batch in two and lowers `max_batch` for the batches after it."""
        out = [None] * len(reqs)
        for flag in (False, True):
            idx = [i for i, r in enumerate(reqs) if r.sample == flag]
            if idx:
                for i, res in zip(idx, self._generate_safe([reqs[i] for i in idx], flag)):
                    out[i] = res
        return out

    def _generate_safe(self, reqs, sample):
        import torch
        try:
            return self._generate(reqs, sample)
        except torch.cuda.OutOfMemoryError:
            if len(reqs) == 1:
                raise
        # retry outside the handler: inside it the failed frames still hold their tensors
        torch.cuda.empty_cache()
        half = len(reqs) // 2
        self.batcher.max_batch = max(1, min(self.batcher.max_batch, half))
        self.oom += 1
        print("[batching] CUDA OOM at batch %d (padded %d): split, max_batch now %d"
              % (len(reqs), max(len(r.ids) for r in reqs), self.batcher.max_batch), file=sys.stderr, flush=True)
        return self._generate_safe(reqs[:half], sample) + self._generate_safe(reqs[half:], sample)

    def _generate(self, reqs, sample):
        import torch
        from transformers import LogitsProcessorList
        import decode
        n, width = len(reqs), max(len(r.ids) for r in reqs)
        im_end = self.dec.im_end
        input_ids = torch.full((n, width), im_end, dtype=torch.long)
        attn = torch.zeros((n, width), dtype=torch.long)
        for i, r in enumerate(reqs):  # left padding
            input_ids[i, width - len(r.ids):] = torch.tensor(r.ids)
            attn[i, width - len(r.ids):] = 1
        input_ids, attn = input_ids.to(self.device), attn.to(self.device)
        steps = [decode._Step(self.dec, width, r.dates, r.prefix) for r in reqs]
        limits = [r.max_new for r in reqs]
        proc = _BatchProc(steps, limits, width, im_end)
        kw = dict(do_sample=True, temperature=0.6, top_p=0.95, top_k=0) if sample else dict(do_sample=False)
        with self._stats_lock:
            self.calls += 1
            if sample:
                torch.manual_seed(self.seed + self.calls)
        t0 = time.time()
        with torch.no_grad():
            gen = self.model.generate(input_ids=input_ids, attention_mask=attn, max_new_tokens=max(limits),
                                      logits_processor=LogitsProcessorList([proc]), eos_token_id=im_end,
                                      pad_token_id=im_end, **kw)
        secs = time.time() - t0
        out = []
        for i, (r, st) in enumerate(zip(reqs, steps)):
            toks = gen[i, width:].tolist()
            if im_end in toks:
                toks = toks[:toks.index(im_end) + 1]
            toks = toks[:r.max_new]  # a forced end past the budget is not part of the message
            info = dict(st.info, prompt_tokens=len(r.ids), new_tokens=len(toks), think_tokens=st.n_think,
                        seconds=secs, stopped=bool(toks and toks[-1] == im_end), batch=n, padded=width)
            body = self.tok.decode([t for t in toks if t != im_end], skip_special_tokens=False)
            out.append(("<think>\n" + r.prefix + body, info))
            self._record(info)
        return out

    def _record(self, info):
        s = self.stats
        with self._stats_lock:
            s["steps"] += 1
            s["think_cut"] += int(bool(info["think_cut"]))
            s["unstopped"] += int(not info["stopped"])
            s["new_tokens"] += info["new_tokens"]
            s["seconds"] += info["seconds"] / info["batch"]  # this row's share of the batch's wall time


# ---- --sample: a fixed stratified subset

def stratified_sample(sessions: list[dict], n: int) -> list[dict]:
    """`n` sessions, the same ones on every call for the same set: strata are (world, first tag),
    ordered by name; inside a stratum sessions are ordered by a hash of their id; the subset takes
    one session from each stratum in turn until `n` are drawn. Returned in the set's own order.
    n <= 0 or n >= len(sessions): every session."""
    if n <= 0 or n >= len(sessions):
        return list(sessions)
    strata: dict = {}
    for s in sessions:
        strata.setdefault((s.get("world", ""), (s.get("tags") or [""])[0]), []).append(s)
    for members in strata.values():
        members.sort(key=lambda s: hashlib.sha256(s["id"].encode()).hexdigest())
    order = [strata[k] for k in sorted(strata)]
    picked, depth = set(), 0
    while len(picked) < n:
        for members in order:
            if depth < len(members) and len(picked) < n:
                picked.add(members[depth]["id"])
        depth += 1
    return [s for s in sessions if s["id"] in picked]
