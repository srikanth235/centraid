"""Paraphrase phrasing families with Sonnet, verify each paraphrase, cache every call on disk.

Per family: one paraphrase call (templates with the same placeholders, the deciding phrase marked
with [[...]]) and one verification call (does the family's gold action still answer each one?),
plus a mechanical slot-preservation check. Rejected paraphrases are logged with the reason.

usage: python paraphrase.py OUT_DIR [--jobs 6]
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import hashlib
import json
import re
import subprocess
import sys
import threading
from pathlib import Path

from families import CATEGORY, F

PH = re.compile(r"\{([A-Z0-9_]+)\}")
MARK = re.compile(r"\[\[(.+?)\]\]")
LOCK = threading.Lock()
CALLS = {"made": 0, "cached": 0, "failed": 0}

PARA_PROMPT = """You write request templates for a personal assistant app that manages one person's own data \
(tasks, calendar events, notes, contacts, photos, documents, debts, a password locker, groups for shared expenses).

Request type: {desc}
Seed templates:
{seeds}

Write {n} NEW templates that ask for exactly the same action, varied in register: terse commands, casual texting \
(lowercase, abbreviations like "pls"/"u"/"tmrw" but only outside placeholders), polite full sentences, British, \
Indian and American idioms, voice-dictation style, questions and commands. Vary the idiom for the key verb.

Rules:
- Keep placeholders in curly braces EXACTLY as written ({slots}); use each at most once; required: {required}.
- Put [[ ]] around the short phrase (1-5 words) that decides what the person wants (the verb or idiom); it may be split in two [[ ]] parts around a placeholder, never more.
- Do not add any facts: no names, dates, times, numbers or amounts that are not placeholders.
- Do not change the meaning (no extra conditions, no other action, no different kind of item).
Output only a JSON array of strings."""

VERIFY_PROMPT = """A personal assistant app will perform this action: {desc}
Placeholders in braces stand for concrete values ({slots}).{optional}
For each numbered request below, answer true only if that action is exactly what the person asks for \
(same action, same kind of item, no extra or missing condition), otherwise false.

{items}

Output only a JSON array of {k} booleans, in order."""


def cache_call(cache: Path, prompt: str, log) -> str | None:
    h = hashlib.sha256(prompt.encode()).hexdigest()[:24]
    p = cache / f"{h}.json"
    if p.exists():
        with LOCK:
            CALLS["cached"] += 1
        return json.loads(p.read_text())["out"]
    for attempt in range(3):
        try:
            r = subprocess.run(["claude", "-p", "--model", "sonnet", "--tools", "", "--strict-mcp-config",
                                "--no-session-persistence"], input=prompt, capture_output=True, text=True, timeout=240,
                               cwd="/tmp")
        except subprocess.TimeoutExpired:
            continue
        if r.returncode == 0 and r.stdout.strip():
            with LOCK:
                CALLS["made"] += 1
            p.write_text(json.dumps({"prompt": prompt, "out": r.stdout}))
            return r.stdout
    with LOCK:
        CALLS["failed"] += 1
    log({"event": "call_failed", "prompt": prompt[:200]})
    return None


def parse_json_list(s: str | None):
    """The last JSON array in the reply (models sometimes send a corrected second block)."""
    if not s:
        return None
    blocks = re.findall(r"```(?:json)?\s*(\[.*?\])\s*```", s, re.S) or re.findall(r"\[.*\]", s, re.S)
    for b in reversed(blocks):
        try:
            return json.loads(re.sub(r",\s*\]", "]", b))
        except json.JSONDecodeError:
            continue
    return None


def slot_info(fid: str) -> tuple[set, set]:
    sets = [set(PH.findall(t)) for t in F[fid]["t"]]
    return set.union(*sets), set.intersection(*sets)


def check(fid: str, t: str) -> str | None:
    allowed, required = slot_info(fid)
    got = PH.findall(t)
    if len(got) != len(set(got)):
        return "placeholder repeated"
    if not set(got) <= allowed:
        return f"unknown placeholder {set(got) - allowed}"
    if not required <= set(got):
        return f"missing placeholder {required - set(got)}"
    marks = MARK.findall(t)
    if len(marks) > (3 if fid.startswith("multi.") else 2):
        return "too many [[ ]]"
    if fid in CATEGORY and marks:
        return "marker in a category request"
    if not marks and any(MARK.search(s) for s in F[fid]["t"]) and not fid.startswith("decline"):
        return "no [[ ]]"
    if fid not in CATEGORY and re.search(r"\d", PH.sub("", MARK.sub(lambda m: m.group(1), t))):
        return "digit outside placeholders"
    if "{" in PH.sub("", t) or "}" in PH.sub("", t):
        return "stray brace"
    return None


CATEGORY_PROMPT = """You write test requests for a personal assistant app that manages one person's own data \
(tasks, calendar, notes, contacts, photos, documents, debts, a password locker, shared-expense groups).

Category: {desc}
Examples:
{seeds}

Write {n} NEW, different requests of exactly this category, varied in topic and register (terse, casual texting, \
polite, British/Indian/American idioms, voice-dictation style). Keep placeholders in braces exactly as written \
({slots}), required: {required}. No other names of people. Output only a JSON array of strings."""


def family(fid: str, cache: Path, log, n: int = 14) -> dict:
    fam = F[fid]
    allowed, required = slot_info(fid)
    seeds = "\n".join(f"- {t}" for t in fam["t"])
    slots = ", ".join("{" + s + "}" for s in sorted(allowed)) or "none"
    req = ", ".join("{" + s + "}" for s in sorted(required)) or "none"
    prompt = (CATEGORY_PROMPT if fid in CATEGORY else PARA_PROMPT).format(
        desc=fam["desc"], seeds=seeds, n=30 if fid in CATEGORY else n, slots=slots, required=req)
    out = parse_json_list(cache_call(cache, prompt, log))
    cands, rejected = [], []
    seen = {t.lower() for t in fam["t"]}
    for t in out or []:
        if not isinstance(t, str):
            continue
        t = t.strip()
        why = check(fid, t)
        if not why and t.lower() in seen:
            why = "duplicate"
        if why:
            rejected.append((t, why))
            continue
        seen.add(t.lower())
        cands.append(t)
    ok = []
    if cands:
        items = "\n".join(f"{i + 1}. {t.replace('[[', '').replace(']]', '')}" for i, t in enumerate(cands))
        opt = sorted(allowed - required)
        optional = (" These placeholders are optional; a request that leaves them out still counts: "
                    + ", ".join("{" + o + "}" for o in opt) + ".") if opt else ""
        verdict = parse_json_list(cache_call(cache, VERIFY_PROMPT.format(desc=fam["desc"], slots=slots, items=items,
                                                                          k=len(cands), optional=optional), log))
        if not verdict or len(verdict) != len(cands):
            rejected += [(t, "verifier gave no usable answer") for t in cands]
        else:
            for t, v in zip(cands, verdict):
                (ok.append(t) if v is True else rejected.append((t, "verifier: gold action does not answer it")))
    for t, why in rejected:
        log({"event": "rejected", "family": fid, "template": t, "why": why})
    return {"family": fid, "accepted": ok, "rejected": len(rejected)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--jobs", type=int, default=6)
    ap.add_argument("--only", default="")
    a = ap.parse_args()
    out = Path(a.out)
    cache = out / "claude_cache"
    cache.mkdir(parents=True, exist_ok=True)
    logf = open(out / "paraphrase_rejects.jsonl", "a")

    def log(obj):
        with LOCK:
            logf.write(json.dumps(obj, ensure_ascii=False) + "\n")
            logf.flush()

    fids = [f for f in F if not a.only or f.startswith(a.only)]
    res = {}
    with cf.ThreadPoolExecutor(a.jobs) as ex:
        futs = {ex.submit(family, f, cache, log, 24 if f in ("rows.frame.show", "value.count", "rows.frame.any") else 14): f
                for f in fids}
        for fu in cf.as_completed(futs):
            r = fu.result()
            res[r["family"]] = r
            print(f"{r['family']}: +{len(r['accepted'])} ({r['rejected']} rejected)", file=sys.stderr, flush=True)
    pool = {f: {"seeds": F[f]["t"], "para": res[f]["accepted"]} for f in fids}
    old = json.loads((out / "phrasing_pool.json").read_text()) if (out / "phrasing_pool.json").exists() else {}
    old.update(pool)
    (out / "phrasing_pool.json").write_text(json.dumps(old, indent=1, ensure_ascii=False))
    stats = {"calls_made": CALLS["made"], "calls_cached": CALLS["cached"], "calls_failed": CALLS["failed"],
             "accepted": sum(len(r["accepted"]) for r in res.values()), "rejected": sum(r["rejected"] for r in res.values())}
    (out / "paraphrase_stats.json").write_text(json.dumps(stats, indent=1))
    print(json.dumps(stats), file=sys.stderr)


if __name__ == "__main__":
    main()
