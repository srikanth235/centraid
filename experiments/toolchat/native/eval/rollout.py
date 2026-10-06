"""Rollout driver (#1044 phase 0.3/0.4): the CPU side of "run the model over fresh training prompts, keep what it gets right".

    python3 eval/rollout.py sets   --built DIR [DIR ...] [--name roll] [--tokens]
    python3 eval/rollout.py sets   --sample --screen-report REPORT.json [-k 6] [--frac 0.3] [--seed 1044] [--name roll]
    python3 eval/rollout.py export --screen-run RUN [...] --screen-report REPORT [...] [--sample-run RUN [...] --sample-report REPORT [...]]
                                   --out DIR --worlds DIR [--runtime NATIVETOOLS] [-m 2] [-p 2] [--jobs 4]

The loop (the GPU runs are the owner's; nothing here launches one):

  1. `sets` merges the gold files of build.py outputs (`--built`, each `<W>/<W>.gold.jsonl` with its `<W>.report.json`; only the
     sessions that VERIFIED, `pass` in the report, are gold) into the screen set `eval/sets/<name>-screen.jsonl`: every session
     once, for a greedy pass of the current model. `replay` (the build's replay summary) is dropped, nothing reads it.
  2. The owner scores the screen set (train/vm/score_ckpt.sh); the scoring run writes run.jsonl and report.json.
  3. `sets --sample` writes `eval/sets/<name>-sample.jsonl`: k copies (ids `<id>-s<k>`, k from 1) of every session that failed the
     screen pass, plus a deterministic fraction of the passing ones (a pure function of seed and id, so the same sessions on every
     run): a passing session still yields failed samples, which the preference pairs need. The copies are scored with
     NATIVE_SAMPLE=1 (temperature 0.6, top-p 0.95 at every step), see README "Rollouts".
  4. The owner scores the sample set the same way.
  5. `export` turns the scored runs into training data:
       rft.jsonl.gz   up to m passing rollouts per session (exactly distinct assistant text), as records in the format of a line of
                      data/train.jsonl.gz: the model's own message of each step (think and call, as the runtime was sent them) as
                      the assistant target, the runtime's reply as the tool turn. A rollout counts only if EVERY turn passes.
       dpo.jsonl.gz   {"id", "chosen", "rejected"} pairs for train.py --dpo, at most p per session (see "Pairs" below).
       summary.json   the counts.

Records. A rollout is replayed through the runtime (the build's own mechanism: eval/run.py `run_session` with a backend that sends the
recorded message of each step) to recover what the run file does not keep: the compaction notices the runtime sends at each later
user message. The tool turns are then what the model saw at that point of the session, as a reference session's record has them
(authored/build.py `records`). The replay must reproduce the recorded replies step for step, else the rollout is skipped
(`replay_diverged`): it was made by another runtime. An assistant step the runtime answered with `error:` carries `loss: false`, as
a reference repair call does: it stays in the text the later steps see and is not trained on. A rollout in which the loop breaker
fired (repeat, loop, cap), a think was cut, or a message is not one think + one call is no RFT example.

Pairs. train.py scores a record by the SUM of the log-probs of its label tokens; the label mask honours `loss: false` on an assistant
message (fmt.encode), so earlier turns can ride along as context only. For a session with a passing rollout P and a failing one F,
t is the first turn F fails. Both records are cut at the end of turn t (what a session of t + 1 turns would give), every assistant
message before the labelled region carries `loss: false`, and the labelled region is the divergent part of turn t:
  exact    P and F show the model the very same context up to turn t (same earlier messages and replies, same turn t user message):
           the labelled region starts at the first step of turn t whose message differs, the shared steps before it are context.
           The preference is about that decision alone and the shared prefix cancels in the DPO margin.
  context  the earlier turns differ (P and F took different but passing paths): each record keeps its OWN earlier turns, as context
           only, and the whole turn t is labelled. Each side is scored on the context it was generated from, so nothing is off-policy.
Exact pairs are preferred; a pair is built from the passing rollouts that also qualify for RFT. The error steps of the chosen record
are unlabelled (as in RFT); those of the rejected record stay labelled, they are the behaviour being dispreferred. A failing
rollout whose divergent message is not one think + one call cannot be a record and gives no pair (`rejected_unparseable`).

Run files are read as run.py / run_batched.py write them (records appended as sessions finish, so a killed run may end in a torn
line). A torn line, a record with an `error`, one that is not a dict with a `turns` list of steps carrying `model` text and a
`response`, one with fewer turns than its gold, and a record whose scoring is missing are skipped and counted, never raised.
"""

from __future__ import annotations

import argparse
import collections
import concurrent.futures as cf
import dataclasses
import gzip
import hashlib
import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
NATIVE = HERE.parent
sys.path[:0] = [str(HERE), str(NATIVE / "train"), str(NATIVE)]

import lib  # noqa: E402
import render  # noqa: E402

SETS = HERE / "sets"
SAMPLE_RE = re.compile(r"(.*)-s(\d+)")
SKILL_RE = re.compile(r"S\d+")
TOOLS_MODE = "sig"  # the fine-tuned model's prompt (what build.py writes and the hf eval runs)


# ---------------------------------------------------------------------------------------------
# ids, fractions, tags
# ---------------------------------------------------------------------------------------------


def sample_id(sid: str, k: int) -> str:
    """The id of the k-th sampled copy (k from 1) of session `sid`."""
    return f"{sid}-s{k}"


def split_sample_id(rid: str, known: set | frozenset | None = None) -> tuple[str, int | None]:
    """(session id, k) of a run id; k is None for a screen id. A session id may itself end in `-s<digits>`: when `known` (the
    screen set's ids) holds the whole id, it is a screen id."""
    if known is not None and rid in known:
        return rid, None
    m = SAMPLE_RE.fullmatch(rid)
    if not m or int(m.group(2)) < 1:
        return rid, None
    return m.group(1), int(m.group(2))


def keep_fraction(sid: str, frac: float, seed: int) -> bool:
    """Deterministic draw: True for a `frac` share of ids, a pure function of (seed, id), independent of the order or the
    other sessions (so the sample set of a screen run is the same on every call)."""
    if frac <= 0:
        return False
    if frac >= 1:
        return True
    h = int(hashlib.sha256(f"{seed}:{sid}".encode()).hexdigest()[:12], 16) / float(1 << 48)
    return h < frac


def tag_keys(tags: list[str]) -> list[str]:
    """The tags of a session as counted in the summary: a skill tag (`i3skill S<n>`, two words in the list) is one key."""
    out, i = [], 0
    tags = [str(t) for t in tags or []]
    while i < len(tags):
        if tags[i] == "i3skill" and i + 1 < len(tags) and SKILL_RE.fullmatch(tags[i + 1]):
            out.append(f"i3skill {tags[i + 1]}")
            i += 2
        else:
            out.append(tags[i])
            i += 1
    return out


# ---------------------------------------------------------------------------------------------
# set files
# ---------------------------------------------------------------------------------------------


def read_json_lines(path: str | Path, counts: collections.Counter | None = None) -> list:
    """The parsable JSON lines of a file (plain or .gz). A torn or non-JSON line is skipped and counted in `counts['torn_lines']`."""
    path = Path(path)
    opener = gzip.open if path.suffix == ".gz" else open
    out = []
    with opener(path, "rt", encoding="utf-8") as fh:
        try:
            for line in fh:
                if not line.strip():
                    continue
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    if counts is not None:
                        counts["torn_lines"] += 1
        except (EOFError, OSError):  # a truncated .gz
            if counts is not None:
                counts["torn_lines"] += 1
    return out


def write_jsonl(path: str | Path, rows) -> int:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    opener = gzip.open if path.suffix == ".gz" else open
    n = 0
    with opener(path, "wt", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
            n += 1
    return n


def built_gold(dirs: list[str | Path]) -> tuple[list[dict], dict[str, dict]]:
    """(gold rows, per-world counts) of build.py outputs. A `--built` directory is one build's output root (`<W>/<W>.gold.jsonl`
    beside `<W>/<W>.report.json`) or a single world's directory. Only the sessions whose report entry has `pass` are gold (the gold
    file also holds the sessions that did not verify). `replay` is dropped."""
    rows, per_world = [], {}
    for d in dirs:
        d = Path(d)
        golds = sorted(d.glob("*/*.gold.jsonl")) + sorted(d.glob("*.gold.jsonl"))
        if not golds:
            raise SystemExit(f"--built {d}: no <W>/<W>.gold.jsonl")
        for gf in golds:
            report = {r["id"]: bool(r.get("pass")) for r in json.loads(gf.with_name(gf.name.replace(".gold.jsonl", ".report.json")).read_text())}
            for line in gf.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                s = json.loads(line)
                w = per_world.setdefault(s["world"], {"kept": 0, "dropped": 0})
                if report.get(s["id"]):
                    s.pop("replay", None)
                    rows.append(s)
                    w["kept"] += 1
                else:
                    w["dropped"] += 1
    ids = [s["id"] for s in rows]
    dup = sorted({i for i in ids if ids.count(i) > 1})
    if dup:
        raise SystemExit(f"duplicate session ids across --built: {dup[:5]}")
    return rows, per_world


def failed_turns(report: dict | list | str | Path, counts: collections.Counter | None = None) -> dict[str, set[int]]:
    """{run id: failed turns (1-based)} from score.py's report.json (`failed`: one entry per failed turn; a session of a
    blocked gold carries ` (blocked: ...)` after its id, dropped here)."""
    if isinstance(report, (str, Path)):
        report = json.loads(Path(report).read_text())
    entries = report["failed"] if isinstance(report, dict) else report
    out: dict[str, set[int]] = collections.defaultdict(set)
    for e in entries:
        out[re.sub(r" \(blocked:.*\)$", "", str(e["id"]))].add(int(e["turn"]))
    return dict(out)


def rescore(run: list[dict], gold: list[dict]) -> dict[str, set[int]]:
    """The failed turns of a run scored against `gold` by score.py (the report.json of a scoring run says the same; this is for a run
    scored by hand). Needs the world keys files (EVAL_WORLDS)."""
    import score

    out: dict[str, set[int]] = {}
    for s in score.score(run, gold)["sessions"]:
        bad = {i + 1 for i, t in enumerate(s["turns"]) if not t["pass"]}
        if bad:
            out[s["id"]] = bad
    return out


def stage_failed(rows: list[dict], run_files: list | None, reports: list | None) -> dict[str, set[int]]:
    """{run id: failed turns} of one scoring stage (the screen set, or the sample set) from its report.json files (the scoring run's own
    output), else by scoring its run files here. A report counts only when its `sessions` add up to the set's rows: a report that
    covers part of the set would read as passes for the rest."""
    if reports:
        out: dict[str, set[int]] = {}
        total = 0
        for rep in reports:
            d = json.loads(Path(rep).read_text())
            total += int(d["sessions"])
            for k, v in failed_turns(d).items():
                out.setdefault(k, set()).update(v)
        if total != len(rows):
            raise SystemExit(f"the reports {[str(r) for r in reports]} score {total} sessions, the set has {len(rows)}: "
                             "not the reports of this set")
        return out
    gold = {s["id"]: s for s in rows}
    recs = [r for f in run_files or [] for r in read_json_lines(f)]
    return rescore([r for r in recs if isinstance(r, dict) and r.get("id") in gold and valid_run(r, gold[r["id"]]) is None], rows)


def sample_rows(screen: list[dict], failed: dict[str, set[int]], k: int, frac: float, seed: int) -> tuple[list[dict], dict]:
    """The sample set: k copies of every screen-failed session, and of the `frac` share of the passing ones `keep_fraction` draws."""
    rows, n_fail, n_pass = [], 0, 0
    for s in screen:
        if s["id"] in failed:
            n_fail += 1
        elif keep_fraction(s["id"], frac, seed):
            n_pass += 1
        else:
            continue
        for j in range(1, k + 1):
            rows.append({**s, "id": sample_id(s["id"], j)})
    return rows, {"screened": len(screen), "screen_failed": n_fail, "passing_sampled": n_pass, "k": k, "frac": frac, "seed": seed,
                  "sessions_sampled": n_fail + n_pass, "rows": len(rows)}


def estimate_tokens(rows: list[dict], records: dict[str, dict], tok=None) -> dict:
    """What the reference sessions of `rows` weigh, as the model reads them: per assistant step, the tokens of everything before it
    (the prefix is read again at every step: the HF generate keeps no cache across steps) and the tokens it writes. `tok` is a HF
    tokenizer; without one, 3.6 characters a token (marked in the result). The model's own rollouts run a little longer than a
    reference."""
    prompt = gen = full = steps = missing = 0
    for s in rows:
        rec = records.get(s["id"])
        if rec is None:
            missing += 1
            continue
        text, spans = render.render(rec["messages"])
        if tok is not None:
            enc = tok(text, add_special_tokens=False, return_offsets_mapping=True)
            starts = [a for a, _ in enc["offset_mapping"]]
            import bisect

            full += len(starts)
            for a, b in spans:
                lo = bisect.bisect_left(starts, a)
                hi = bisect.bisect_left(starts, b)
                prompt += lo
                gen += hi - lo
                steps += 1
        else:
            full += len(text) / 3.6
            for a, b in spans:
                prompt += a / 3.6
                gen += (b - a) / 3.6
                steps += 1
    return {"sessions": len(rows), "without_reference_record": missing, "steps": steps, "full_session_tokens": int(full),
            "prompt_tokens_read": int(prompt), "generated_tokens": int(gen), "tokenizer": "qwen" if tok is not None else "chars/3.6"}


def load_reference_records(dirs: list[str | Path]) -> dict[str, dict]:
    """{session id: record} of the build's `<W>.jsonl.gz` files (record ids are `<split>-<session id>`)."""
    out = {}
    for d in dirs:
        d = Path(d)
        for f in sorted(d.glob("*/*.jsonl.gz")) + sorted(d.glob("*.jsonl.gz")):
            for r in read_json_lines(f):
                out[r["id"].split("-", 1)[1]] = r
    return out


def load_tokenizer(name: str | None):
    try:
        from transformers import AutoTokenizer

        return AutoTokenizer.from_pretrained(name or "Qwen/Qwen3.5-0.8B")
    except Exception as e:  # noqa: BLE001
        print(f"note: no tokenizer ({e!r:.100}); estimating by characters", file=sys.stderr)
        return None


def cmd_sets(a) -> None:
    sets_dir = Path(a.sets_dir)
    screen_path = sets_dir / f"{a.name}-screen.jsonl"
    if not a.sample:
        if not a.built:
            raise SystemExit("sets: --built DIR [DIR ...] (the build.py outputs to merge)")
        rows, per_world = built_gold(a.built)
        n = write_jsonl(screen_path, rows)
        turns = sum(len(s["turns"]) for s in rows)
        print(f"{screen_path}: {n} sessions, {turns} turns, {len(per_world)} worlds, {screen_path.stat().st_size / 1e6:.1f} MB")
        for w in sorted(per_world):
            print(f"  {w}: kept {per_world[w]['kept']}, dropped {per_world[w]['dropped']}")
        out_rows, stats = rows, {"sessions": n, "turns": turns}
    else:
        if not a.screen_report and not a.screen_run:
            raise SystemExit("sets --sample: --screen-report REPORT.json (or --screen-run RUN to score it here: EVAL_WORLDS)")
        screen = lib.read_jsonl(screen_path)
        failed = stage_failed(screen, [a.screen_run] if a.screen_run else None, [a.screen_report] if a.screen_report else None)
        rows, stats = sample_rows(screen, failed, a.k, a.frac, a.seed)
        sample_path = sets_dir / f"{a.name}-sample.jsonl"
        write_jsonl(sample_path, rows)
        print(f"{sample_path}: {len(rows)} rows = {stats['sessions_sampled']} sessions x {a.k}: {stats['screen_failed']} failed the "
              f"screen, {stats['passing_sampled']} of {stats['screened'] - stats['screen_failed']} passing drawn at {a.frac} "
              f"(seed {a.seed}); screen pass {100 * (1 - stats['screen_failed'] / max(1, stats['screened'])):.1f}%")
        out_rows = [{**s} for s in rows]
    if a.tokens:
        if not a.built:
            raise SystemExit("--tokens needs --built (the reference records the estimate weighs)")
        refs = load_reference_records(a.built)
        base = [{**s, "id": split_sample_id(s["id"], frozenset(refs))[0]} for s in out_rows]  # a sample copy weighs its reference
        est = estimate_tokens(base, refs, load_tokenizer(a.tokenizer))
        print("token estimate (reference sessions; the model's rollouts run a little longer): " + json.dumps(est))


# ---------------------------------------------------------------------------------------------
# rollouts
# ---------------------------------------------------------------------------------------------


def first_call(text: str) -> str:
    return lib.first_call(text)


def is_synthetic(step: dict) -> bool:
    """The runtime's own ending of a retracted turn: no model message was sent."""
    return step.get("runtime") == "never_mind"


def valid_run(rec, gold: dict) -> str | None:
    """None when `rec` is a complete run record of `gold`, else why it is not (error | tools_mode | malformed | partial)."""
    if not isinstance(rec, dict) or not isinstance(rec.get("id"), str):
        return "malformed"
    if rec.get("error"):
        return "error"
    if rec.get("tools_mode") not in (None, TOOLS_MODE):
        return "tools_mode"  # the records are written for the `sig` prompt the model was trained on
    turns = rec.get("turns")
    if not isinstance(turns, list):
        return "malformed"
    for t in turns:
        if not isinstance(t, dict) or not isinstance(t.get("steps"), list):
            return "malformed"
        for s in t["steps"]:
            if not isinstance(s, dict) or not isinstance(s.get("model"), str) or not isinstance(s.get("response"), dict):
                return "malformed"
            if not isinstance(s["response"].get("text", ""), str):
                return "malformed"
    if len(turns) < len(gold["turns"]):
        return "partial"
    return None


def is_error_step(step: dict) -> bool:
    """A step the runtime rejected as a malformed call: the build's own test of a repair call (authored/build.py `verify_session`)."""
    r = step.get("response") or {}
    return bool((r.get("effect") or {}).get("error")) or str(r.get("text", "")).startswith("error")


def is_loop_step(step: dict) -> bool:
    """A step the loop breaker or the step cap answered (`repeat`, `loop`, `cap` in the effect)."""
    eff = (step.get("response") or {}).get("effect") or {}
    return any(eff.get(k) for k in ("repeat", "loop", "cap"))


@dataclasses.dataclass
class Rollout:
    id: str  # the run id: the session's, or `<id>-s<k>`
    sid: str
    k: int | None  # None: the screen pass
    rec: dict
    first_fail: int | None  # 1-based turn, None: every turn passed
    clean: bool = True  # no loop-breaker step, no cut think: may be an RFT example
    order: int = 0

    @property
    def passed(self) -> bool:
        return self.first_fail is None

    def steps(self, turn: int | None = None):
        turns = self.rec["turns"] if turn is None else [self.rec["turns"][turn]]
        return [s for t in turns for s in t["steps"] if not is_synthetic(s)]

    def texts(self) -> tuple:
        """The assistant messages the model sent, in order: what two rollouts must differ in to be two examples."""
        return tuple(first_call(s["model"]) for s in self.steps())


def collect(screen: list[dict], runs: dict[str, list], failed: dict[str, set[int]], counts: collections.Counter,
            keep_loops: bool = False) -> dict[str, list[Rollout]]:
    """Group the run records by session: {session id: [Rollout, ...]}, the screen pass first, then the samples by k. A run id that
    belongs to no screen session, a duplicate, an invalid record are counted and left out."""
    gold = {s["id"]: s for s in screen}
    known = frozenset(gold)
    out: dict[str, list[Rollout]] = collections.defaultdict(list)
    seen: set[str] = set()
    for stage, recs in runs.items():
        for rec in recs:
            rid = rec.get("id") if isinstance(rec, dict) else None
            if not isinstance(rid, str):
                counts["skipped_malformed"] += 1
                continue
            sid, k = split_sample_id(rid, known)
            if sid not in gold:
                counts["skipped_unknown_id"] += 1
                continue
            if rid in seen:
                counts["skipped_duplicate"] += 1
                continue
            seen.add(rid)
            why = valid_run(rec, gold[sid])
            if why:
                counts[f"skipped_{why}"] += 1
                continue
            bad = failed.get(rid)
            roll = Rollout(rid, sid, k, rec, min(bad) if bad else None, order=len(out[sid]))
            if any(s.get("think_cut") for s in roll.steps()):
                roll.clean = False
                counts["unclean_think_cut"] += 1
            elif not keep_loops and any(is_loop_step(s) for s in roll.steps()):
                roll.clean = False
                counts["unclean_loop"] += 1
            out[sid].append(roll)
    for sid in out:
        out[sid].sort(key=lambda r: (-1 if r.k is None else r.k))
        for i, r in enumerate(out[sid]):
            r.order = i
    return out


def pick_rft(rolls: list[Rollout], m: int) -> list[Rollout]:
    """Up to m passing clean rollouts of a session, deduplicated by the exact assistant text, the screen pass first."""
    out, seen = [], set()
    for r in rolls:
        if not (r.passed and r.clean) or r.texts() in seen:
            continue
        seen.add(r.texts())
        out.append(r)
        if len(out) >= m:
            break
    return out


# ---- pairs --------------------------------------------------------------------------------------


def context_key(r: Rollout, t: int) -> tuple:
    """What the model has been shown when turn t (0-based) starts: every earlier turn's message, step and reply, and the user message
    of turn t (its block and its text)."""
    turns = r.rec["turns"]
    earlier = tuple((tt.get("user"), tt.get("preground") or "",
                     tuple((first_call(s["model"]), s["response"].get("text", "")) for s in tt["steps"])) for tt in turns[:t])
    return earlier + ((turns[t].get("user"), turns[t].get("preground") or ""),)


def diverge_step(p: Rollout, f: Rollout, t: int) -> int | None:
    """The first step of turn t (0-based) where the two rollouts differ, None when they do not."""
    a, b = p.rec["turns"][t]["steps"], f.rec["turns"][t]["steps"]
    for j in range(max(len(a), len(b))):
        if j >= len(a) or j >= len(b):
            return j
        if (first_call(a[j]["model"]), a[j]["response"].get("text", "")) != (first_call(b[j]["model"]), b[j]["response"].get("text", "")):
            return j
    return None


@dataclasses.dataclass
class Candidate:
    p: Rollout
    f: Rollout
    t: int  # 0-based first failing turn of f
    kind: str  # exact | context
    j: int  # first labelled step of turn t


def candidates(passing: list[Rollout], failing: list[Rollout]) -> list[Candidate]:
    """Every (passing, failing) combination that makes a pair: the failing rollout's first failing turn exists in both, and the
    two differ there. Failing rollouts with the same message at that turn (same context) count once."""
    out, seen = [], set()
    for f in failing:
        t = f.first_fail - 1
        if t < 0 or t >= len(f.rec["turns"]) or not f.rec["turns"][t]["steps"] or all(is_synthetic(s) for s in f.rec["turns"][t]["steps"]):
            continue
        sig = (t, context_key(f, t), tuple(first_call(s["model"]) for s in f.rec["turns"][t]["steps"]))
        if sig in seen:
            continue
        seen.add(sig)
        for p in passing:
            if t >= len(p.rec["turns"]) or all(is_synthetic(s) for s in p.rec["turns"][t]["steps"]):
                continue
            if context_key(p, t) == context_key(f, t):
                j = diverge_step(p, f, t)
                if j is None:
                    continue
                out.append(Candidate(p, f, t, "exact", j))
            else:
                out.append(Candidate(p, f, t, "context", 0))
    return out


def rank(cands: list[Candidate], p_max: int):
    """Yield candidates best first, one rejected rollout and one chosen rollout at most once while others are left: exact before
    context, then a failing rollout not used yet, then a passing one not used yet, then the order of the rollouts."""
    used_f: set[str] = set()
    used_p: set[str] = set()
    left = list(cands)
    while left:
        best = min(left, key=lambda c: (c.kind != "exact", c.f.id in used_f, c.p.id in used_p, c.f.order, c.p.order))
        left.remove(best)
        used_f.add(best.f.id)
        used_p.add(best.p.id)
        yield best


# ---------------------------------------------------------------------------------------------
# replay: the transcript a rollout leaves in the runtime
# ---------------------------------------------------------------------------------------------


class Unparseable(Exception):
    """An assistant message that is not one think + one call."""


class NoLabel(Exception):
    """A pair side with no assistant step to train on (the other rollout's divergent step has no counterpart here)."""


@dataclasses.dataclass
class Replayed:
    messages: list[dict]  # lib.Transcript messages: user (text, preground), assistant (content), tool (content), as finally compacted
    rec: dict  # the replayed run record (steps with the runtime's responses)


class StaticReplayer:
    """The transcript read straight off the run record, no runtime: the tool turns are the recorded replies, uncompacted. For tests
    and for a runtime-free look; the export uses `RuntimeReplayer` so that the tool turns carry the runtime's compaction."""

    def __init__(self, system=None):
        self._system = system or (lambda session: {"role": "system", "content": f"system of {session['id']}", "tools": []})

    def system(self, session: dict) -> dict:
        return self._system(session)

    def replay(self, session: dict, rec: dict, upto: int | None = None) -> Replayed:
        turns = rec["turns"][: upto if upto is not None else len(rec["turns"])]
        msgs = []
        for t in turns:
            msgs.append({"role": "user", "content": "", "text": t["user"], "preground": t.get("preground")})
            for s in t["steps"]:
                if is_synthetic(s):
                    continue
                msgs.append({"role": "assistant", "content": first_call(s["model"])})
                msgs.append({"role": "tool", "content": s["response"].get("text", "")})
        return Replayed(msgs, {**rec, "turns": turns})


class RuntimeReplayer:
    """Replays a rollout through the runtime exactly as the eval driver ran it (eval/run.py `run_session`: same turn loop, loop
    breaker, step cap, compaction), sending the recorded message of each step. Needs seeded vaults (`lib.VAULTS`) of the worlds the
    run was made on, and the runtime that made the run."""

    def __init__(self):
        import run  # noqa: F401  (imported here, not in a worker thread; so is the tokenizer the renderer's system block uses)

        render.tokenizer()
        self._sys: dict[tuple, dict] = {}

    def system(self, session: dict) -> dict:
        key = (session["world"], session["today"], session["me"])
        if key not in self._sys:
            with lib.Runtime(*key, flags=["--tools", TOOLS_MODE]) as rt:
                p = rt.req({"op": "prompt"})
            self._sys[key] = {"role": "system", "content": p["system"], "tools": p["tools"]}
        return self._sys[key]

    def replay(self, session: dict, rec: dict, upto: int | None = None) -> Replayed:
        import run

        steps = [[s for s in t["steps"] if not is_synthetic(s)] for t in rec["turns"]]

        class Recorded(run.Backend):
            name = "rollout"
            tools_mode = rec.get("tools_mode") or TOOLS_MODE
            transcript = None

            def step(self, transcript, ctx):
                self.transcript = transcript
                try:
                    s = steps[ctx["turn"]][ctx["step"]]
                except IndexError:
                    return run.StepOut(text="(no recorded step)", think_cut=False)
                return run.StepOut(text=s["model"], think_cut=bool(s.get("think_cut")))

        backend = Recorded()
        sub = dict(session, turns=session["turns"][: upto if upto is not None else len(session["turns"])])
        new = run.run_session(sub, backend)
        if backend.transcript is None:
            raise Unparseable("no model step was sent")
        head = render.render([self.system(session)])[0]
        if head != backend.transcript.system_rendered:
            raise AssertionError("system record does not render as the eval transcript's system block")
        return Replayed(backend.transcript.messages, new)


def same_run(old: dict, new: dict, upto: int) -> bool:
    """The replay reproduced the recorded run over the first `upto` turns: same steps, same replies, same turn endings."""
    if len(new["turns"]) < upto:
        return False
    for ot, nt in zip(old["turns"][:upto], new["turns"][:upto]):
        a = [(s.get("runtime"), s["response"].get("text", ""), bool(s["response"].get("ends_turn"))) for s in ot["steps"]]
        b = [(s.get("runtime"), s["response"].get("text", ""), bool(s["response"].get("ends_turn"))) for s in nt["steps"]]
        if a != b:
            return False
    return True


_PARSE = None


def assistant_record(text: str) -> dict | None:
    """hf_backend.assistant_record (the parser the eval's own transcript goes through); imported once, before any worker thread
    needs it (a first import from several threads at once races inside transformers)."""
    global _PARSE
    if _PARSE is None:
        from hf_backend import assistant_record as parse

        _PARSE = parse
    return _PARSE(text)


def to_messages(sysrec: dict, tmsgs: list[dict], labelled) -> list[dict]:
    """The records of authored/build.py `records`, from a transcript's messages: the system record, the user turns as the harness
    writes them (`render.user_content`), the assistant steps as parsed records (think, tool, args: the model's own message),
    the tool turns as the transcript holds them; trailing tool turns dropped. `labelled(turn, step)` says whether the assistant
    step is trained; an unlabelled one carries `loss: false`."""
    msgs, turn, step = [sysrec], -1, 0
    for m in tmsgs:
        if m["role"] == "user":
            turn, step = turn + 1, 0
            msgs.append({"role": "user", "content": render.user_content(m["text"], m.get("preground"))})
        elif m["role"] == "assistant":
            rec = assistant_record(m["content"])
            if rec is None:
                raise Unparseable(f"turn {turn + 1} step {step + 1}: {m['content'][:120]!r}")
            if not labelled(turn, step):
                rec["loss"] = False
            step += 1
            msgs.append(rec)
        else:
            msgs.append({"role": "tool", "content": m["content"]})
    while msgs[-1]["role"] == "tool":
        msgs.pop()
    return msgs


def envelope(rid: str, session: dict, msgs: list[dict], n_turns: int, source: str) -> dict:
    """A line of train.jsonl.gz: the key set and order of authored/build.py's writer."""
    return {"id": rid, "split": session.get("set", "train"), "world": session["world"], "today": session["today"],
            "me": session["me"], "tools_mode": TOOLS_MODE, "messages": msgs, "n_turns": n_turns,
            "tags": session.get("tags", []), "source": source}


def step_flags(rec: dict) -> dict[tuple[int, int], dict]:
    """{(turn, step): the recorded step} of the model steps (a retraction's synthetic ending is no model step)."""
    return {(ti, si): s for ti, t in enumerate(rec["turns"]) for si, s in enumerate(x for x in t["steps"] if not is_synthetic(x))}


def rft_record(session: dict, roll: Rollout, rp: Replayed, sysrec: dict, j: int) -> dict:
    flags = step_flags(rp.rec)
    msgs = to_messages(sysrec, rp.messages, lambda ti, si: not is_error_step(flags.get((ti, si), {})))
    return envelope(f"rft-{roll.sid}-r{j}", session, msgs, len(session["turns"]), "rft")


def pair_record(session: dict, rp: Replayed, sysrec: dict, c: Candidate, side: str, rid: str) -> dict:
    """One side of a pair: cut at the end of turn t, labelled from step j of turn t on; the chosen side's own error steps unlabelled."""
    flags = step_flags(rp.rec)

    def labelled(ti, si):
        if ti != c.t or si < c.j:
            return False
        return side == "rejected" or not is_error_step(flags.get((ti, si), {}))

    msgs = to_messages(sysrec, rp.messages, labelled)
    if not any(m["role"] == "assistant" and m.get("loss", True) for m in msgs):
        raise NoLabel("no labelled step")
    return envelope(rid, session, msgs, c.t + 1, f"dpo-{c.kind}")


# ---------------------------------------------------------------------------------------------
# export
# ---------------------------------------------------------------------------------------------


def export_rollouts(screen: list[dict], runs: dict[str, list], failed: dict[str, set[int]], replayer, m: int = 2, p: int = 2,
                    keep_loops: bool = False, jobs: int = 1) -> tuple[list[dict], list[dict], dict]:
    """(RFT records, DPO pairs, summary) from the scored runs. `runs`: {stage: [run records]} (stage `screen` or `sample`);
    `failed`: {run id: failed turns}; `replayer`: RuntimeReplayer, or StaticReplayer in tests."""
    counts: collections.Counter = collections.Counter()
    gold = {s["id"]: s for s in screen}
    by_session = collect(screen, runs, failed, counts, keep_loops)
    per_world: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    per_tag: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)

    def bump(sid: str, key: str, n: int = 1) -> None:
        per_world[gold[sid]["world"]][key] += n
        for tg in tag_keys(gold[sid].get("tags", [])):
            per_tag[tg][key] += n

    screened = {sid: next((r for r in rs if r.k is None), None) for sid, rs in by_session.items()}
    for s in screen:
        bump(s["id"], "screened")
    n_screen_pass = 0
    for s in screen:
        r = screened.get(s["id"])
        if r is not None and r.passed:
            n_screen_pass += 1
            bump(s["id"], "screen_pass")
    cache: dict[tuple, Replayed | Exception] = {}
    errors: list[str] = []

    def replay(sid: str, roll: Rollout, upto: int | None):
        key = (roll.id, upto)
        if key not in cache:
            try:
                rp = replayer.replay(gold[sid], roll.rec, upto)
                cache[key] = rp if same_run(roll.rec, rp.rec, upto if upto is not None else len(roll.rec["turns"])) else RuntimeError("replay_diverged")
            except Unparseable as e:
                cache[key] = e
            except Exception as e:  # noqa: BLE001  (the runtime died, a vault is missing, a key: the rollout is left out, counted)
                cache[key] = RuntimeError(f"replay_error: {e!r:.160}")
                if len(errors) < 8:
                    errors.append(f"{roll.id}: {e!r:.300}")
        return cache[key]

    rft: list[dict] = []
    pairs: list[dict] = []
    sessions = sorted(by_session)

    def work(sid: str):
        session = gold[sid]
        rolls = by_session[sid]
        local: collections.Counter = collections.Counter()
        recs, prs = [], []
        sysrec = replayer.system(session)
        passing = [r for r in rolls if r.passed]
        local["rollouts"] += len(rolls)
        local["rollouts_passed"] += len(passing)
        picked, chosen_pool = [], pick_rft(rolls, 10**6)
        for r in chosen_pool:
            if len(picked) >= m:
                break
            rp = replay(sid, r, None)
            if isinstance(rp, Exception):
                local["rft_skipped_" + ("unparseable" if isinstance(rp, Unparseable) else str(rp).split(":")[0])] += 1
                continue
            try:
                recs.append(rft_record(session, r, rp, sysrec, len(picked) + 1))
            except Unparseable:
                local["rft_skipped_unparseable"] += 1
                continue
            picked.append(r)
        # pairs: a clean passing rollout against a rollout that failed
        failing = [r for r in rolls if not r.passed]
        local["rollouts_failed"] += len(failing)
        if chosen_pool and failing:
            n = 0
            for c in rank(candidates(chosen_pool, failing), p):
                if n >= p:
                    break
                rc, rr = replay(sid, c.p, c.t + 1), replay(sid, c.f, c.t + 1)
                if isinstance(rc, Exception) or isinstance(rr, Exception):
                    bad = rc if isinstance(rc, Exception) else rr
                    local["pair_skipped_" + ("unparseable" if isinstance(bad, Unparseable) else str(bad).split(":")[0])] += 1
                    continue
                pid = f"{sid}-p{n + 1}"
                try:
                    ch = pair_record(session, rc, sysrec, c, "chosen", f"dpo-{pid}-c")
                except Unparseable:
                    local["pair_skipped_chosen_unparseable"] += 1
                    continue
                except NoLabel:
                    local["pair_skipped_no_label"] += 1
                    continue
                try:
                    rj = pair_record(session, rr, sysrec, c, "rejected", f"dpo-{pid}-r")
                except Unparseable:
                    local["pair_skipped_rejected_unparseable"] += 1
                    continue
                except NoLabel:
                    local["pair_skipped_no_label"] += 1
                    continue
                prs.append({"id": pid, "chosen": ch, "rejected": rj})
                local["pairs_" + c.kind] += 1
                n += 1
        return sid, recs, prs, local, bool(passing), bool(picked)

    assistant_record("")  # the parser's first import, before the workers
    with cf.ThreadPoolExecutor(max_workers=max(1, jobs)) as pool:
        results = list(pool.map(work, sessions))
    with_pass = with_rft = 0
    for sid, recs, prs, local, any_pass, any_rft in results:
        rft += recs
        pairs += prs
        with_pass += any_pass
        with_rft += any_rft
        for k, v in local.items():
            counts[k] += v
        if any_pass:
            bump(sid, "with_pass")
        if any_rft:
            bump(sid, "with_rft")
        bump(sid, "rft", len(recs))
        bump(sid, "pairs", len(prs))
    n_screened = len(screen)
    sampled = {sid for sid, rs in by_session.items() if any(r.k is not None for r in rs)}
    summary = {
        "sessions_screened": n_screened,
        "screen_runs_read": sum(1 for r in screened.values() if r is not None),
        "screen_pass": n_screen_pass,
        "screen_pass_rate": round(n_screen_pass / n_screened, 4) if n_screened else None,
        "sessions_sampled": len(sampled),
        "sample_rollouts": sum(1 for rs in by_session.values() for r in rs if r.k is not None),
        "sample_rollouts_passed": sum(1 for rs in by_session.values() for r in rs if r.k is not None and r.passed),
        "sessions_with_pass": with_pass,
        "sessions_with_rft": with_rft,
        "rft_records": len(rft),
        "pairs": len(pairs),
        "pairs_exact": sum(1 for pr in pairs if pr["chosen"]["source"] == "dpo-exact"),
        "pairs_context": sum(1 for pr in pairs if pr["chosen"]["source"] == "dpo-context"),
        "params": {"m": m, "p": p, "keep_loops": keep_loops},
        "counters": dict(sorted(counts.items())),
        "replay_errors": errors,
        "per_world": {w: dict(sorted(c.items())) for w, c in sorted(per_world.items())},
        "per_tag": {t: dict(sorted(c.items())) for t, c in sorted(per_tag.items())},
    }
    return rft, pairs, summary


def cmd_export(a) -> None:
    sets_dir = Path(a.sets_dir)
    screen_path = Path(a.screen_set) if a.screen_set else sets_dir / f"{a.name}-screen.jsonl"
    screen = lib.read_jsonl(screen_path)
    counts: collections.Counter = collections.Counter()
    runs = {"screen": [r for p in a.screen_run for r in read_json_lines(p, counts)],
            "sample": [r for p in (a.sample_run or []) for r in read_json_lines(p, counts)]}
    lib.WORLDS = Path(a.worlds)  # the keys files score.py reads; the vaults of the replay are seeded from them
    lib.VAULTS = Path(a.vaults)
    failed = stage_failed(screen, a.screen_run, a.screen_report)
    if a.sample_run:
        sample_path = Path(a.sample_set) if a.sample_set else sets_dir / f"{a.name}-sample.jsonl"
        failed.update(stage_failed(lib.read_jsonl(sample_path), a.sample_run, a.sample_report))
    if a.runtime:
        lib.NT = os.path.abspath(a.runtime)
    import run
    import seed_worlds

    run.TMP = a.tmp
    seed_worlds.NT = lib.NT
    Path(a.tmp).mkdir(parents=True, exist_ok=True)
    needed = sorted({s["world"] for s in screen})
    for w in needed:
        if not (lib.VAULTS / w / "vault").exists():
            seed_worlds.seed(w, lib.VAULTS)
    rft, pairs, summary = export_rollouts(screen, runs, failed, RuntimeReplayer(), a.m, a.p, a.keep_loops, a.jobs)
    for k, v in counts.items():
        summary["counters"][k] = summary["counters"].get(k, 0) + v
    summary["runtime"] = {"path": lib.NT, "sha256": hashlib.sha256(Path(lib.NT).read_bytes()).hexdigest()[:12]}
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    write_jsonl(out / "rft.jsonl.gz", rft)
    write_jsonl(out / "dpo.jsonl.gz", pairs)
    (out / "summary.json").write_text(json.dumps(summary, indent=1, ensure_ascii=False))
    print(f"{out}: {summary['rft_records']} RFT records from {summary['sessions_with_rft']} sessions, {summary['pairs']} pairs "
          f"({summary['pairs_exact']} exact, {summary['pairs_context']} context); screen pass {summary['screen_pass']}/"
          f"{summary['sessions_screened']} = {summary['screen_pass_rate']}; counters {json.dumps(summary['counters'])}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--sets-dir", default=str(SETS), help="where the set files are written / read (default eval/sets)")
    common.add_argument("--name", default="roll", help="set file prefix: <name>-screen.jsonl, <name>-sample.jsonl")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("sets", parents=[common], help="write the screen set, or with --sample the sample set")
    s.add_argument("--built", nargs="+", help="build.py output roots (<W>/<W>.gold.jsonl + <W>.report.json)")
    s.add_argument("--sample", action="store_true", help="write the sample set from a scored screen run")
    s.add_argument("--screen-report", help="report.json of the screen scoring run")
    s.add_argument("--screen-run", help="run.jsonl of the screen run, to rescore (needs EVAL_WORLDS); --screen-report is the usual way")
    s.add_argument("-k", type=int, default=6, help="copies per sampled session")
    s.add_argument("--frac", type=float, default=0.3, help="share of the passing sessions that are sampled too")
    s.add_argument("--seed", type=int, default=1044, help="seed of that draw")
    s.add_argument("--tokens", action="store_true", help="estimate the tokens of the set from the reference records of --built")
    s.add_argument("--tokenizer", help="tokenizer for --tokens (default Qwen/Qwen3.5-0.8B from the HF cache)")
    e = sub.add_parser("export", parents=[common], help="RFT records, DPO pairs and a summary from the scored screen and sample runs")
    e.add_argument("--screen-run", nargs="+", required=True)
    e.add_argument("--screen-report", nargs="+", help="report.json of the screen scoring run (else the runs are rescored: EVAL_WORLDS)")
    e.add_argument("--sample-run", nargs="+")
    e.add_argument("--sample-set", help="default <sets-dir>/<name>-sample.jsonl")
    e.add_argument("--sample-report", nargs="+")
    e.add_argument("--screen-set", help="default <sets-dir>/<name>-screen.jsonl")
    e.add_argument("--out", required=True)
    e.add_argument("--worlds", required=True, help="the worlds directory the sets were built on (build.py --worlds-dir)")
    e.add_argument("--runtime", help="the nativetools binary that scored the runs (default $NATIVETOOLS)")
    e.add_argument("--vaults", default="/dev/shm/rollout/vaults", help="where the worlds are seeded for the replay")
    e.add_argument("--tmp", default="/dev/shm/rollout/tmp", help="per-replay vault copies")
    e.add_argument("-m", type=int, default=2, help="RFT records per session at most")
    e.add_argument("-p", type=int, default=2, help="DPO pairs per session at most")
    e.add_argument("--jobs", type=int, default=4)
    e.add_argument("--keep-loops", action="store_true", help="let a rollout in which the loop breaker fired be an RFT example")
    a = ap.parse_args()
    {"sets": cmd_sets, "export": cmd_export}[a.cmd](a)


if __name__ == "__main__":
    main()
