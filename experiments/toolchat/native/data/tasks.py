"""Task records and the correction-round teacher (SPEC §11.4): the policy executor as `next_step`.

A task is one generated session (`sessions-<split>-*.jsonl.gz`, one JSON line each): its world seed and size,
flags, `today`, `me`, and per turn the abstract request (`req`), the message, and the gold steps.
Val and correction-pool tasks are generated with `--fresh-sessions`, so each starts from the pristine
seeded world. `worlds-<split>-*.jsonl.gz` holds each world's key -> vault id map.

    from tasks import load_tasks, prepare_session, next_step
    task = load_tasks("…/sessions-pool-700000-700500.jsonl.gz")[0]
    env = prepare_session(task, workdir)          # seeds (cached) + copies the pristine vault, opens the session
    transcript = [{"prompt": env.prompt}]         # then, as the model runs:
    transcript.append({"user": text, "response": env.session.user(text)})
    transcript.append({"call": {"tool": t, "args": a}, "response": env.session.call(t, a)})   # or call_text
    step = next_step(task, transcript, env.session)   # -> (trace, {"tool", "args"}) or None
The transcript may leave the gold path anywhere (wrong rows shown, extra results, error observations);
`next_step` rebuilds the state from it and returns the policy's correct next call and its §7 trace.
It never sends a call to the session.
"""
from __future__ import annotations

import copy
import dataclasses
import functools
import glob
import gzip
import json
import random
from pathlib import Path

import rt
import worlds
from dates import DatePhrase
from policy import Action, Executor, GenError, Ref, Req, State, Step, Target, ordered

_TYPES = {"Action": Action, "Target": Target, "Ref": Ref, "DatePhrase": DatePhrase, "Req": Req}


# ------------------------------------------------------------------ (de)serialisation of abstract requests
def _enc(x):
    if dataclasses.is_dataclass(x):
        d = {"__t": type(x).__name__}
        for f in dataclasses.fields(x):
            d[f.name] = _enc(getattr(x, f.name))
        for k, v in vars(x).items():          # ad-hoc attributes (builder, template, sub_reading)
            if k not in d and not k.startswith("_"):
                d[k] = _enc(v)
        return d
    if isinstance(x, (list, tuple)):
        return [_enc(v) for v in x] if isinstance(x, list) else {"__tuple": [_enc(v) for v in x]}
    if isinstance(x, set):
        return {"__set": sorted(_enc(v) for v in x)}
    if isinstance(x, dict):
        return {k: _enc(v) for k, v in x.items()}
    return x


def _dec(x):
    if isinstance(x, list):
        return [_dec(v) for v in x]
    if isinstance(x, dict):
        if "__tuple" in x:
            return tuple(_dec(v) for v in x["__tuple"])
        if "__set" in x:
            return set(_dec(v) for v in x["__set"])
        if "__t" in x:
            cls = _TYPES[x["__t"]]
            names = {f.name for f in dataclasses.fields(cls)}
            obj = cls(**{k: _dec(v) for k, v in x.items() if k in names})
            for k, v in x.items():
                if k not in names and k != "__t":
                    setattr(obj, k, _dec(v))
            return obj
        return {k: _dec(v) for k, v in x.items()}
    return x


def req_to_json(r: Req) -> dict:
    return _enc(r)


def req_from_json(d: dict) -> Req:
    return _dec(d)


def load_tasks(path: str) -> list[dict]:
    out = []
    for l in gzip.open(path, "rt"):
        t = json.loads(l)
        t["_path"] = str(path)
        out.append(t)
    return out


@functools.lru_cache(maxsize=4)
def _world_keys(pattern: str) -> dict:
    out = {}
    for f in glob.glob(pattern):
        for l in gzip.open(f, "rt"):
            w = json.loads(l)
            out[w["world"]] = w["keys"]
    return out


def pristine_model(task: dict, keys: dict | None = None) -> worlds.Model:
    _, model = worlds.build_world(task["world"], task.get("size"))
    if keys is None:
        keys = _world_keys(task.get("worlds_glob") or str(Path(task["_path"]).parent / "worlds-*.jsonl.gz"))[task["world"]]
    for k, rid in keys.items():
        if k in model.rows:
            model.rows[k].id = rid
    return model


@dataclasses.dataclass
class Env:
    session: rt.Session
    prompt: dict
    vault: Path
    keys: dict


def prepare_session(task: dict, workdir: Path) -> Env:
    """Seed the task's world (cached per world), copy the pristine vault, open the task's session."""
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    base = workdir / f"world{task['world']}"
    keys_file = workdir / f"world{task['world']}.keys.json"
    if not keys_file.exists():
        w, _ = worlds.build_world(task["world"], task.get("size"))
        rt.remove_vault(base)
        seeded = rt.seed(w, base, workdir)
        keys_file.write_text(json.dumps({k: v["id"] for k, v in seeded["keys"].items()}))
    vault = workdir / f"world{task['world']}-s{task['session']}"
    rt.remove_vault(vault)
    rt.copy(base, vault)
    s = rt.Session(vault, task["today"], task["me"], directory=task["flags"]["directory"],
                   preground=task["flags"]["preground"], tools=task.get("tools_mode", rt.TOOLS_MODE))
    return Env(s, s.prompt(), vault, json.loads(keys_file.read_text()))


# ------------------------------------------------------------------ the teacher
class NextStep(Exception):
    def __init__(self, think: str, tool: str, args: dict):
        super().__init__(tool)
        self.think, self.tool, self.call_args = think, tool, args   # (Exception.args is reserved)


class _Replay(Executor):
    """The executor, answered from the transcript: a call the model already made (same tool and args)
    gets its recorded response; the first call it did not make is the next step."""

    def __init__(self, model, st, recorded, absorb: bool):
        super().__init__(None, model, st, random.Random(0))
        self.recorded = list(recorded)
        self.absorb = absorb

    def call(self, think: str, tool: str, args: dict) -> dict:
        a = ordered(tool, args)
        for i, (t, ra, resp) in enumerate(self.recorded):
            if t == tool and ordered(t, ra) == a:
                self.recorded.pop(i)
                self.steps.append(Step(think, tool, a, resp.get("text", ""), resp.get("effect"),
                                       bool(resp.get("ends_turn")), resp.get("obs")))
                if self.absorb:
                    _absorb(self.st, self.model, self, resp)
                return resp
        raise NextStep(think, tool, a)


def _absorb(st: State, model, ex: Executor, resp: dict) -> None:
    st.on_obs(resp)
    eff = resp.get("effect") or {}
    if not eff.get("error"):
        ex.apply_diff(eff)
    for coll in (eff.get("rows"), (eff.get("answer") or {}).get("rows"), eff.get("ambiguous"), eff.get("created"),
                 (eff.get("ask") or {}).get("options"), eff.get("already"), (eff.get("diff") or {}).get("rows")):
        for x in coll or []:
            if isinstance(x, dict) and x.get("id") and x.get("n"):
                st.id_n[x["id"]] = x["n"]


def next_step(task: dict, transcript: list[dict], runtime_session=None, keys: dict | None = None):
    """-> (trace, {"tool", "args"}) for the current turn, or None when the gold plan has no further step."""
    model = pristine_model(task, keys)
    prompt = next(e["prompt"] for e in transcript if "prompt" in e)
    st = State(prompt)
    helper = Executor(None, model, st, random.Random(0))
    users = [i for i, e in enumerate(transcript) if "user" in e]
    if not users:
        raise ValueError("the transcript has no user message yet")
    cur = users[-1]
    for e in transcript[:cur]:
        if "user" in e:
            st.on_user(e["response"])
        elif "call" in e:
            _absorb(st, model, helper, e["response"])
    st.on_user(transcript[cur]["response"])
    recorded = [(e["call"]["tool"], e["call"]["args"], e["response"]) for e in transcript[cur + 1:] if "call" in e]
    turn = len(users) - 1
    if turn >= len(task["turns"]):
        return None
    req = req_from_json(task["turns"][turn]["req"])
    # 1: the model followed the plan so far: replay its calls in the executor's own order
    trial_model, trial_st = copy.deepcopy(model), copy.deepcopy(st)
    ex = _Replay(trial_model, trial_st, recorded, absorb=True)
    try:
        ex.run(copy.deepcopy(req))
        if not ex.recorded:
            return None
    except NextStep as n:
        if not ex.recorded:
            return n.think, {"tool": n.tool, "args": n.call_args}
    except GenError:
        pass
    # 2: the model left the path: everything it saw counts, then decide from there
    for t, a, resp in recorded:
        _absorb(st, model, helper, resp)
    ex = _Replay(model, st, recorded, absorb=False)
    try:
        ex.run(copy.deepcopy(req))
    except NextStep as n:
        return n.think, {"tool": n.tool, "args": n.call_args}
    except GenError:
        return None
    return None


def self_check(path: str, workdir: str, limit: int = 20, off_path: bool = True) -> dict:
    """On the gold path the teacher must return exactly the gold call at every step; with a stray call
    injected first it must still return a call (reported, not asserted)."""
    import collections
    res = collections.Counter()
    bad = []
    for task in load_tasks(path)[:limit]:
        if not task.get("fresh"):
            continue
        env = prepare_session(task, Path(workdir))
        try:
            tr = [{"prompt": env.prompt}]
            for ti, turn in enumerate(task["turns"]):
                if turn.get("aborted"):
                    break
                tr.append({"user": turn["user"], "response": env.session.user(turn["user"])})
                if off_path and ti == 0:
                    stray = {"tool": "search", "args": {"text": "zzqx"}}
                    tr.append({"call": stray, "response": env.session.call("search", stray["args"])})
                    got = next_step(task, tr, env.session, env.keys)
                    res["off_path_answered" if got else "off_path_none"] += 1
                    if got and (got[1]["tool"], got[1]["args"]) == (turn["gold_steps"][0]["tool"], turn["gold_steps"][0]["args"]):
                        res["off_path_gold"] += 1
                for g in turn["gold_steps"]:
                    got = next_step(task, tr, env.session, env.keys)
                    res["steps"] += 1
                    if got and got[1]["tool"] == g["tool"] and got[1]["args"] == ordered(g["tool"], g["args"]):
                        res["same_call"] += 1
                        if got[0] == g["think"]:
                            res["same_trace"] += 1
                        elif len(bad) < 5:
                            bad.append({"trace_want": g["think"], "trace_got": got[0]})
                    else:
                        bad.append({"task": task["session"], "world": task["world"], "want": g, "got": got})
                    tr.append({"call": {"tool": g["tool"], "args": g["args"]},
                               "response": env.session.call(g["tool"], g["args"])})
                res["after_turn_none"] += next_step(task, tr, env.session, env.keys) is None
        finally:
            env.session.close()
            rt.remove_vault(env.vault)
    return {"counts": dict(res), "bad": bad[:5]}


if __name__ == "__main__":
    import sys
    print(json.dumps(self_check(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 20), indent=1,
                     default=str)[:4000])
