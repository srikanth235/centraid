"""Decoding for one assistant step: free (SPEC §6.6, §9).

The model writes text and the runtime reads it; nothing is masked. HF `generate` runs greedy (or sampled) under one logits
processor, `_Step`, that does the three things generation needs and `generate` does not do by itself:

- the think guard: after `think_limit` think tokens `</think>` is forced (counted as `think_cut` in the step info);
- the rendered call: once the think is closed, the call is not sampled but written by `fmt.call_of_think`, the very function the
  data builder checks against every authored call, as forced tokens (`rendered_call`). A think that does not state a whole call
  leaves the call to the model;
- one call per message: after `</tool_call>` only `<|im_end|>` (the eval driver cuts there anyway; free decoding would otherwise
  run on to max_new_tokens).

The think is the slot lines of the v4 trace (CONTRACT_V3.md section 8); with NATIVE_TRACE=v3.1 it is the v3.1 trace. The step info
carries `think_cut`, `rendered_call`, `prompt_tokens`, `new_tokens`, `think_tokens`, `seconds` and `stopped`.

Greedy by default; `sample=True` draws at temperature 0.6, top-p 0.95 (seeded by `seed`), which is how rollouts are made
(NATIVE_SAMPLE=1).
"""
from __future__ import annotations

import time

import torch

import fmt


class Decoder:
    def __init__(self, model, tok, think_limit=200, max_new_tokens=512):
        """`think_limit`: think tokens before `</think>` is forced. Once the think is closed the call is not sampled but written by
        `fmt.call_of_think` (a think that does not state a whole call leaves the call to the model)."""
        self.model, self.tok = model, tok
        self.im_end = tok.convert_tokens_to_ids(fmt.render.IM_END)
        self.think_end = tok.convert_tokens_to_ids(fmt.render.THINK_CLOSE)
        self.call_end = tok.convert_tokens_to_ids(fmt.render.TOOL_CALL_CLOSE)
        self.think_limit = think_limit
        self.max_new_tokens = max_new_tokens

    def step(self, msgs, sample=False, seed=0, prefix=""):
        """One assistant message for render.py records (the shared renderer builds the prompt)."""
        prompt = fmt.render.render_prompt_for_generation(msgs)
        return self.generate(prompt, sample=sample, seed=seed, dates=fmt.trace3().dates_line_of(msgs), prefix=prefix)

    def complete(self, prompt, sample=False, seed=0, prefix=""):
        """One assistant message for an already rendered prompt (ending `<|im_start|>assistant\\n`,
        with or without the `<think>\\n` the template's generation prompt adds). `prefix`: the start of the think, given
        (`retry: <slot>\\n` after the runtime refused a slot); the message returned includes it."""
        if prompt.endswith(fmt.render.ASSISTANT_HEADER):
            prompt += fmt.render.THINK_OPEN
        return self.generate(prompt, sample=sample, seed=seed, dates=fmt.dates_line_in_prompt(prompt), prefix=prefix)

    @torch.no_grad()
    def generate(self, prompt, sample=False, seed=0, dates=None, prefix=""):
        """Greedy (or sampled) HF `generate` under the step's processor. Returns (text, info);
        text is the whole assistant message and starts with `<think>\\n`. `dates`: the `dates:` line of the turn's message
        (what the call the think states is read against); `prefix`: the first lines of the think, given before the model writes."""
        from transformers import LogitsProcessorList
        assert prompt.endswith(fmt.render.ASSISTANT_OPEN), prompt[-60:]
        dev = next(self.model.parameters()).device
        pre = self.tok(prefix, add_special_tokens=False)["input_ids"] if prefix else []
        ids = torch.tensor([self.tok(prompt, add_special_tokens=False)["input_ids"] + pre], device=dev)
        proc = _Step(self, ids.shape[1], dates, prefix)
        kw = dict(do_sample=True, temperature=0.6, top_p=0.95, top_k=0) if sample else dict(do_sample=False)
        if sample:
            torch.manual_seed(seed)
        t0 = time.time()
        gen = self.model.generate(input_ids=ids, attention_mask=torch.ones_like(ids),
                                  max_new_tokens=self.max_new_tokens, logits_processor=LogitsProcessorList([proc]),
                                  eos_token_id=self.im_end, pad_token_id=self.im_end, **kw)
        out = gen[0, ids.shape[1]:].tolist()
        info = dict(proc.info, prompt_tokens=ids.shape[1], new_tokens=len(out), think_tokens=proc.n_think,
                    seconds=time.time() - t0, stopped=bool(out and out[-1] == self.im_end))
        body = self.tok.decode([t for t in out if t != self.im_end], skip_special_tokens=False)
        return fmt.render.THINK_OPEN + prefix + body, info


class _Step:
    """HF logits processor of one step: the think guard, the call the think states, the stop after the one call."""

    def __init__(self, dec: Decoder, prompt_len: int, dates: str | None = None, prefix: str = ""):
        self.d, self.prompt_len = dec, prompt_len
        self.dates, self.prefix = dates, prefix  # the dates line a `dates[i]` is read against; the think's given first lines
        self.seen, self.in_think, self.n_think = 0, True, 0
        self.forced, self.forced_from = [], 0  # the call the think states, as token ids, and where it starts in the output
        self.info = {"think_cut": False, "rendered_call": False}

    def _render_call(self, think_ids, start):
        """The think is closed: when it states a whole call, queue the call's tokens (a blank line, then the call)."""
        call = fmt.call_of_think(self.prefix + self.d.tok.decode(think_ids, skip_special_tokens=False), self.dates)
        if call is None:
            return
        self.forced = self.d.tok("\n\n" + call, add_special_tokens=False)["input_ids"]
        self.forced_from = start
        self.info["rendered_call"] = True

    def __call__(self, input_ids, scores):
        assert input_ids.shape[0] == 1, "one sequence per step"
        new = input_ids[0, self.prompt_len:].tolist()
        for t in new[self.seen:]:
            if self.in_think:
                if t == self.d.think_end:
                    self.in_think = False
                    k = new.index(t)
                    self._render_call(new[:k], k + 1)
                else:
                    self.n_think += 1
        self.seen = len(new)
        row = scores[0]
        if self.forced and len(new) - self.forced_from < len(self.forced):
            # the call the think states: one token at a time
            want = self.forced[len(new) - self.forced_from]
            row.fill_(float("-inf"))
            row[want] = 0.0
            return scores
        if new and new[-1] == self.d.call_end:
            # one call per message: after `</tool_call>` only `<|im_end|>`
            row.fill_(float("-inf"))
            row[self.d.im_end] = 0.0
            return scores
        if self.in_think and self.n_think >= self.d.think_limit:
            self.info["think_cut"] = True
            keep = row[self.d.think_end].clone()
            row.fill_(float("-inf"))
            row[self.d.think_end] = keep if torch.isfinite(keep) else 0.0
            return scores
        return scores
