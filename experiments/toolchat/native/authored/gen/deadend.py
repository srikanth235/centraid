"""Dead ends and their right exits (phase 5, #1044).

    python3 authored/gen/deadend.py --out DIR [--dry] [--verify] [--worlds train | T01,T02] [--sessions-dir DIR]
                                    [--per-path 30] [--seed 1044] [--jobs 4] [--exclude IDS.json | --exclude-plan P.json]

Three paths, each in a COPY of the session sources, at most one per session, on sessions that have no `bad` step in
the turn it touches (and, with --exclude-plan, none touched by recover.py):

  create      a turn whose reference creates a row: a `find` of the very name (kind and name as the create gives them)
              comes first and finds nothing, then the create. The message states a new thing, the empty read is the
              reason to create.
  near        a turn whose reference names an existing row by a long word of its message: that word is misspelled in the
              message (one letter dropped), the first call is a `find` of the name as typed (empty), the second a `search`
              of it (the near spelling is found), then the unchanged reference.
  not_found   a turn appended to the session: the message asks about something that would have to exist (a task, an
              event, a note, a document, a person) under an invented name; the reference is a `find` (or a `search`)
              that finds nothing, a `search` that finds nothing, and `decline not_found`.

  --dry      the candidate counts per path, nothing written.
  --out DIR  the copy (every `<W>.py` and `<W>_*.py` of the chosen worlds) and DIR/deadend.plan.json.
  --verify   build the touched sessions with authored/build.py --gold-from-ref (NATIVETOOLS, EVAL_VAULTS as there), keep
             an edit only when the session verifies and the runtime answered as the path says (empty find, a search that
             finds the row, a decline), rewrite the copy without the others, write DIR/deadend.report.json.

Deterministic: choices are seeded hashes of (seed, path, session). The sources are never edited in place.
"""
from __future__ import annotations

import os
import argparse
import collections
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402
from common import AUTHORED, Edit, rank, render_call  # noqa: E402

# DEADEND_PATHS narrows the paths (#1044 i2: nt11/nt12 resolve a near spelling and the create find-first is not the
# convention, so the i2 build keeps not_found only)
PATHS = tuple(os.environ.get("DEADEND_PATHS", "create,near,not_found").split(","))
EMPTY_FIND = re.compile(r"^(?:answered: )?0 [\w ]+ called")
EMPTY_SEARCH = re.compile(r"^0 rows match")
FOUND_SEARCH = re.compile(r"^@\d+ · search")
# invented names no world row can contain (the runtime's search is fuzzy per word; verification checks the empty reply)
FAKE = ["Zarvelle", "Quimbly", "Fennick", "Brontide", "Ostrava Quill", "Marrowby", "Tolliver Grange", "Wexcombe",
        "Yarrowdale", "Pellimore", "Hobnell", "Crispin Vauxe", "Dunmarrow", "Lorvane", "Thistlewick", "Garrowby",
        "Vexholt", "Almondsbury Row", "Quenby", "Dravik", "Ismay Corwen", "Pountney", "Skerrow", "Belvoir Marsh",
        "Tamsworth", "Orlaith Venn", "Fyrdale", "Kestrelby", "Moxon Pryce", "Larkhollow", "Zennor Blythe", "Haverlock",
        "Prunella Dray", "Wolvesey", "Ardmoor", "Sennick", "Corvane Ledger", "Piddock", "Ilsabet Frame", "Nettlecombe"]
# kind -> (message templates with {n}, the reference's first step, the verb word) for the not_found turns
NF_TEMPLATES = {
    "task": ["when is the {n} task due", "mark the {n} task as done", "what's the status of the {n} task"],
    "event": ["when's the {n} appointment", "what time is the {n} meeting", "move the {n} event to friday"],
    "note": ["what did i write in the {n} note", "show me the {n} note"],
    "document": ["open the {n} document", "where's the {n} document"],
    "person": ["when did i last speak to {n}", "what's {n}'s role"],
}


def typo(word: str, r) -> str:
    """The word with one inner letter dropped (the position seeded)."""
    i = r.randrange(2, len(word) - 2)
    return word[:i] + word[i + 1:]


def create_name(call: dict) -> str | None:
    for line in call["args"].get("args", "").split("\n"):
        k, _, v = line.partition(":")
        if k.strip() == "name" and v.strip() and "$" not in v:
            return v.strip()
    return None


def generated(sess: dict) -> bool:
    """True when the session already carries one of our edits (a rerun leaves it as it is): a create preceded by a
    find of its own name, a find and a search of one name ahead of a call, or a not_found turn on an invented name."""
    last = sess["turns"][-1]
    if last["ref"] and last["ref"][-1] == {"tool": "decline", "args": {"reason": "not_found"}} \
            and any(f.lower() in last["user"].lower() for f in FAKE):
        return True
    for t in sess["turns"]:
        ref = t["ref"]
        for k, c in enumerate(ref):
            if c["tool"] == "act" and c.get("args", {}).get("verb") == "create" and k >= 1 and ref[k - 1]["tool"] == "find" \
                    and ref[k - 1]["args"].get("name") == create_name(c) and ref[k - 1]["args"].get("kind") == c["args"].get("kind"):
                return True
        if len(ref) >= 3 and ref[0]["tool"] == "find" and ref[1]["tool"] == "search" and \
                ref[0]["args"].get("name") == ref[1]["args"].get("text") and ref[1]["args"].get("kind") == ref[0]["args"].get("kind"):
            return True
    return False


def candidates(sess: dict, seed) -> dict[str, list]:
    out: dict[str, list] = {p: [] for p in ("create", "near", "not_found")}  # every path is collected; PATHS picks
    if generated(sess):
        return out
    for ti, t in enumerate(sess["turns"]):
        ref = t["ref"]
        if any(c.get("bad") for c in ref):
            continue
        for k, c in enumerate(ref):
            a = c.get("args", {})
            if c["tool"] == "act" and a.get("verb") == "create" and a.get("kind") in ("event", "task", "note", "document", "album"):
                n = create_name(c)
                if n and not any(x["tool"] == "find" for x in ref[:k]):
                    out["create"].append((ti, k, {"find": {"tool": "find", "args": {"kind": a["kind"], "name": n}}}))
            if c["tool"] in ("act", "answer", "find", "compute") and a.get("name") and a.get("kind") \
                    and "," not in a["kind"] and k == 0:
                words = [w for w in re.findall(r"[A-Za-z]{6,}", a["name"])
                         if re.search(rf"\b{re.escape(w)}\b", t["user"], re.I)]
                if words:
                    w = max(words, key=len)
                    r = common.rng(seed, "near", sess["id"], str(ti), str(k))
                    bad_w = typo(w, r)
                    m = re.search(rf"\b{re.escape(w)}\b", t["user"], re.I)
                    shown = t["user"][m.start():m.end()]
                    new_user = t["user"][:m.start()] + typo(shown, common.rng(seed, "near", sess["id"], str(ti), str(k))) + t["user"][m.end():]
                    name_t = re.sub(rf"\b{re.escape(w)}\b", bad_w, a["name"], count=1, flags=re.I)
                    out["near"].append((ti, k, {"user": new_user, "name": name_t, "kind": a["kind"]}))
    return out


def nf_turn(sess: dict, seed) -> dict | None:
    r = common.rng(seed, "not_found", sess["id"])
    kind = r.choice(sorted(NF_TEMPLATES))
    fake = r.choice(FAKE)
    msg = r.choice(NF_TEMPLATES[kind]).format(n=fake.lower() if kind != "person" else fake)
    if r.random() < 0.5:
        steps = [{"tool": "find", "args": {"kind": kind, "name": fake.lower() if kind != "person" else fake}},
                 {"tool": "search", "args": {"text": fake.lower() if kind != "person" else fake}}]
    else:
        steps = [{"tool": "search", "args": {"text": fake.lower() if kind != "person" else fake, "kind": kind}}]
    steps.append({"tool": "decline", "args": {"reason": "not_found"}})
    return {"user": msg, "ref": steps, "kind": kind}


def plan(worlds, sessions_dir: Path, seed, per_path: int, exclude: set[str]):
    cands: dict[str, dict[str, list]] = {p: {} for p in ("create", "near", "not_found")}  # PATHS picks below
    info: dict[str, tuple[str, dict]] = {}
    for w in worlds:
        sessions = common.load_sessions(w, sessions_dir)
        usable = common.usable_sites(w, sessions, sessions_dir)
        for s in sessions:
            if s["id"] in exclude or not s["turns"]:
                continue
            info[s["id"]] = (w, s)
            for p, lst in candidates(s, seed).items():
                lst = [x for x in lst if (f := s["turns"][x[0]]["_site"])[0] in usable and usable[f[0]][f[1]] is not None]
                if lst:
                    cands[p][s["id"]] = lst
            if not generated(s) and s["turns"][-1]["_site"][0] in usable:
                cands["not_found"][s["id"]] = [(len(s["turns"]), 0, nf_turn(s, seed))]
    counts = {p: [sum(len(v) for v in cands[p].values()), len(cands[p])] for p in PATHS}
    used: set[str] = set()
    chosen = []
    for p in sorted(PATHS, key=lambda p: counts[p][1]):
        n = 0
        for sid in sorted(cands[p], key=lambda x: rank(seed, p, x)):
            if n >= per_path:
                break
            if sid in used:
                continue
            t, k, d = sorted(cands[p][sid], key=lambda c: rank(seed, p, sid, str(c[0]), str(c[1])))[0]
            w, s = info[sid]
            site = s["turns"][min(t, len(s["turns"]) - 1)]["_site"] if p != "not_found" else s["turns"][0]["_site"]
            chosen.append({"sid": sid, "world": w, "path": p, "turn": t, "step": k, "data": d, "file": site[0],
                           "t_index": site[1], "session_file": s["turns"][-1]["_site"][0]})
            used.add(sid)
            n += 1
    return chosen, counts


def edits_of(c: dict) -> list[Edit]:
    p, d = c["path"], c["data"]
    if p == "create":
        return [Edit(c["file"], c["t_index"], c["step"], render_call(d["find"]))]
    if p == "near":
        steps = [{"tool": "find", "args": {"kind": d["kind"], "name": d["name"]}},
                 {"tool": "search", "args": {"text": d["name"], "kind": d["kind"]}}]
        return [Edit(c["file"], c["t_index"], 0, repr(d["user"]), what="user")] + \
               [Edit(c["file"], c["t_index"], 0, render_call(x)) for x in steps]
    steps = ", ".join(render_call(x) for x in d["ref"])
    text = f'X({c["sid"]!r}, T({d["user"]!r}, decline("not_found"), ref=[{steps}]))'
    return [Edit(c["session_file"], 0, 0, text, what="append")]


def write_copy(src, out, worlds, chosen):
    # two inserts at the same step keep their order: apply_edits places later ones first, so list them reversed
    es: list[Edit] = []
    for c in chosen:
        e = edits_of(c)
        if c["path"] == "near":
            e = [e[0], e[2], e[1]]
        es += e
    common.apply_edits(src, out, worlds, es)


def check(c: dict, msgs: list[dict]) -> str:
    """'' when the runtime answered as the path says, else why not."""
    turns = common.turn_steps(msgs)
    p = c["path"]
    if p == "create":
        t = turns[c["turn"]]
        return "" if c["step"] < len(t) and EMPTY_FIND.search(t[c["step"]][1]) else "the find was not empty"
    if p == "near":
        t = turns[c["turn"]]
        if len(t) < 3 or not EMPTY_FIND.search(t[0][1]):
            return "the find with the near spelling was not empty"
        return "" if FOUND_SEARCH.search(t[1][1]) else "the search did not find rows"
    t = turns[-1]
    if not t or t[-1][0].get("tool") != "decline":
        return "the turn did not end in a decline"
    first = [r for _m, r in t[:-1]]
    if not first or not EMPTY_SEARCH.search(first[-1]) or (len(first) == 2 and not EMPTY_FIND.search(first[0])):
        return "the reads were not empty"
    return ""


def verify(chosen, worlds, out: Path, jobs: int, src: Path | None = None) -> dict[str, str]:
    bdir = out / "_build"
    by_w: dict[str, list[str]] = collections.defaultdict(list)
    for c in chosen:
        by_w[c["world"]].append(c["sid"])
    common.build_many([(w, sorted(s)) for w, s in by_w.items()], out, bdir, n_jobs=jobs)
    verdict = {}
    for w in by_w:
        recs, rep = common.read_records(bdir, w), common.read_report(bdir, w)
        for c in chosen:
            if c["world"] != w:
                continue
            e = rep.get(c["sid"])
            if not e or not e["pass"]:
                verdict[c["sid"]] = "dropped: " + (common.why_dropped_text(e) if e else "no build entry")
            else:
                verdict[c["sid"]] = check(c, recs[c["sid"]])
    if src is not None:
        failed: dict[str, list[str]] = collections.defaultdict(list)
        for c in chosen:
            if verdict[c["sid"]].startswith("dropped"):
                failed[c["world"]].append(c["sid"])
        for sid in common.baseline_failures(failed, src, out, jobs):
            verdict[sid] = "baseline: fails without the edit"
    return verdict


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path)
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--worlds", default="train")
    ap.add_argument("--sessions-dir", type=Path, default=AUTHORED / "sessions")
    ap.add_argument("--per-path", type=int, default=30)
    ap.add_argument("--seed", default="1044")
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--exclude", type=Path, help="a JSON list of session ids not to touch")
    ap.add_argument("--exclude-plan", type=Path, help="a recover.plan.json: its sessions are not touched")
    a = ap.parse_args()
    worlds = common.TRAIN_WORLDS if a.worlds == "train" else a.worlds.split(",")
    excl = set(json.loads(a.exclude.read_text())) if a.exclude else set()
    if a.exclude_plan:
        excl |= {x["sid"] for x in json.loads(a.exclude_plan.read_text())}
    chosen, counts = plan(worlds, a.sessions_dir, a.seed, a.per_path, excl)
    planned = collections.Counter(c["path"] for c in chosen)
    print(f"{'path':10} {'candidates':>10} {'sessions':>9} {'planned':>8}")
    for p in PATHS:
        print(f"{p:10} {counts[p][0]:>10} {counts[p][1]:>9} {planned[p]:>8}")
    if a.dry or not a.out:
        return
    write_copy(a.sessions_dir, a.out, worlds, chosen)
    report = {"planned": dict(planned)}
    if a.verify:
        verdict = verify(chosen, worlds, a.out, a.jobs, a.sessions_dir)
        kept = [c for c in chosen if not verdict[c["sid"]]]
        write_copy(a.sessions_dir, a.out, worlds, kept)
        ok = collections.Counter(c["path"] for c in kept)
        fails = collections.defaultdict(collections.Counter)
        for c in chosen:
            if verdict[c["sid"]]:
                fails[c["path"]][verdict[c["sid"]][:90]] += 1
        base_n = sum(1 for v in verdict.values() if v.startswith("baseline"))
        report.update(verified=dict(ok), sessions_touched=len(kept),
                      verification_rate=round(len(kept) / max(1, len(chosen)), 3), baseline_failures=base_n,
                      rate_without_baseline_failures=round(len(kept) / max(1, len(chosen) - base_n), 3),
                      failures={p: dict(v) for p, v in fails.items()})
        print(f"verified {len(kept)}/{len(chosen)} ({report['verification_rate']:.1%}); {base_n} sessions fail without "
              f"the edit too, so {report['rate_without_baseline_failures']:.1%} of the others")
        for p in PATHS:
            print(f"  {p:10} {ok[p]:>4}/{planned[p]:<4} {dict(fails[p]) if fails[p] else ''}")
        chosen = kept
    (a.out / "deadend.plan.json").write_text(json.dumps(chosen, indent=1, ensure_ascii=False))
    (a.out / "deadend.report.json").write_text(json.dumps(report, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
