"""Collision worlds: add the eval worlds' name-collision density to the train worlds (phase 5, #1044).

    python3 authored/gen/collide.py --out DIR [--dry] [--worlds train | T01,T02] [--profile abc|mean|d]
                                    [--min-adds 2,2,4] [--max-add-frac 0.12] [--word-frac 0.04] [--seed 1044] [--random]
                                    [--keys] [--verify [T01,T10]] [--sessions-dir DIR] [--jobs 4]

Measures four densities on a world (see `measure`):

  first_name     share of people whose first name another person also has
  container      share of containers (group, list, notebook, folder, album) whose name another kind of container has
  same_name      share of rows whose whole name a row of another kind has
  shared_word    share of rows with a word (first significant word counts) that a row of another kind also has

then adds rows, never removes or renames one, so every existing `$key` still resolves, until each density reaches the
profile's target (`abc`: the highest of the eval worlds A, B, C; `mean`: the mean of A to D; `d`: the scale world D; the
numbers are `TARGETS`, because those worlds are held out) and at
least `--min-adds` rows of the first three rules (people twins, container twins, shared-word rows; default 2,2,4), at
most `--max-add-frac` of the world's rows in all (the shared-word rows at most `--word-frac` of them). The added rows are inert for aggregate reads (people without cadence or
links, tasks cancelled and events cancelled before the world's epoch, notes, documents, photos and locker items from the
epoch), so what breaks in a session is a name that now fits two rows. Seeded: same seed, same additions.

  --dry     print the measures before and after per world, nothing written.
  --out DIR write DIR/<W>.json (the transformed worlds; build.py reads them with --worlds-dir DIR).
  --keys    also seed every written world with the runtime (NATIVETOOLS) and write DIR/<W>.keys.json beside it, which is what
            a rollout set built on these worlds needs (`BUNDLE_WORLDS=DIR`, `rollout.py export --worlds DIR`). The command that
            rebuilds the collision worlds from public sources is `python3 authored/gen/collide.py --out DIR --keys`: the
            density targets are `TARGETS`, the twins are those of the names the authored sessions reference, the seed is 1044.
  --verify  run authored/build.py --gold-from-ref on every session of the given worlds (default T01,T10) on the
            original and on the transformed world, and print what breaks: sessions that verified before and no longer
            do, split into the ones the runtime now answers `ambiguous:` (the point: rewrite to pick, or drop) and
            the rest. Writes DIR/collide.verify.json.
"""
from __future__ import annotations

import argparse
import collections
import copy
import datetime
import json
import re
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402
from common import AUTHORED, NATIVE, rng  # noqa: E402

SECTIONS = {"people": "person", "groups": "group", "lists": "list", "events": "event", "tasks": "task",
            "notebooks": "notebook", "notes": "note", "folders": "folder", "documents": "document", "albums": "album",
            "photos": "photo", "debts": "debt", "locker": "locker item"}
CONTAINERS = {"group", "list", "notebook", "folder", "album"}
STOP = set("the and for with from your our into about this that new old day week trip".split())
SURNAMES = ["Hartley", "Whitcombe", "Okonkwo", "Delacroix", "Brannigan", "Seo", "Kowalczyk", "Abernathy", "Lindqvist",
            "Marchetti", "Osei", "Fairweather", "Tanaka", "Quigley", "Vasquez", "Holloway", "Nakamura", "Ferreira"]
TWIN_KINDS = {"list": "lists", "notebook": "notebooks", "folder": "folders", "album": "albums"}
WORD_ROWS = [  # kind, section, name template (the shared word goes in {w}, capitalised in {W})
    ("task", "tasks", "Sort out the {w} paperwork"), ("note", "notes", "{W} ideas"),
    ("document", "documents", "{W} receipts"), ("locker item", "locker", "{W} account"),
    ("event", "events", "{W} catch-up"), ("photo", "photos", "{W} snapshot")]


def rows_of(world: dict) -> list[tuple[str, str]]:
    return [(kind, r["name"]) for sec, kind in SECTIONS.items() for r in world.get(sec, []) if "name" in r]


def words(name: str) -> list[str]:
    return [w for w in re.findall(r"[a-z]{3,}", name.lower()) if w not in STOP]


def measure(world: dict) -> dict[str, float]:
    rs = rows_of(world)
    people = [n for k, n in rs if k == "person"]
    first = collections.Counter(p.split()[0].lower() for p in people)
    conts = [(k, n.lower()) for k, n in rs if k in CONTAINERS]
    ck = collections.defaultdict(set)
    for k, n in conts:
        ck[n].add(k)
    ak = collections.defaultdict(set)
    for k, n in rs:
        ak[n.lower()].add(k)
    wk = collections.defaultdict(set)
    for k, n in rs:
        for w in words(n):
            wk[w].add(k)
    return {
        "first_name": sum(first[p.split()[0].lower()] > 1 for p in people) / max(1, len(people)),
        "container": sum(len(ck[n]) > 1 for _k, n in conts) / max(1, len(conts)),
        "same_name": sum(len(ak[n.lower()]) > 1 for _k, n in rs) / max(1, len(rs)),
        "shared_word": sum(any(len(wk[w]) > 1 for w in words(n)) for _k, n in rs) / max(1, len(rs)),
    }


def referenced(w: str, sessions_dir: Path) -> dict[str, collections.Counter]:
    """What the world's sessions name in their reference calls: person first names, container names, other names'
    words, each with its number of references (a twin of a referenced name is what makes a session ambiguous)."""
    out = {"first": collections.Counter(), "container": collections.Counter(), "word": collections.Counter()}
    for s in common.load_sessions(w, sessions_dir):
        for t in s["turns"]:
            for c in t["ref"]:
                a = c.get("args", {})
                text = a.get("name") or (a.get("text") if c["tool"] == "search" else None)
                if not text or "$" in text:
                    continue
                kind = a.get("kind", "")
                if kind == "person" or (c["tool"] == "search" and not kind):
                    out["first"][text.split()[0].lower()] += 1
                if kind in CONTAINERS:
                    out["container"][text.lower()] += 1
                for x in words(text):
                    out["word"][x] += 1
    return out


# The density each profile aims for, measured on the eval worlds A to D (`measured_targets`). Those worlds are held out
# (R-1088-16), so a public checkout cannot measure them: the numbers are kept here, and `eval/heldout_checks.py` (run by
# `artefacts.py verify-heldout`) holds them to the worlds. `--profile` picks one.
TARGETS = {
    "abc": {"first_name": 0.1875, "container": 0.2, "same_name": 0.020477815699658702, "shared_word": 0.7854406130268199},
    "mean": {"first_name": 0.3197850529100529, "container": 0.18758472886762362, "same_name": 0.015655475282360182,
             "shared_word": 0.6710243230480681},
    "d": {"first_name": 0.8783068783068783, "container": 0.3541666666666667, "same_name": 0.00846979107848673,
          "shared_word": 0.549124788255223},
}


def measured_targets(profile: str) -> dict[str, float]:
    """The targets of a profile as measured on the eval worlds A to D (held out: only where they are)."""
    ms = {n: measure(json.loads((NATIVE / "eval" / "worlds" / f"{n}.json").read_text())) for n in "ABCD"}
    if profile == "d":
        return ms["D"]
    if profile == "mean":
        return {k: statistics.mean(m[k] for m in ms.values()) for k in ms["A"]}
    return {k: max(ms[n][k] for n in "ABC") for k in ms["A"]}


def targets(profile: str) -> dict[str, float]:
    return dict(TARGETS[profile])


def add_row(world: dict, section: str, row: dict, log: list, rule: str) -> None:
    world.setdefault(section, []).append(row)
    log.append((rule, SECTIONS[section], row["name"]))


def transform(world: dict, tgt: dict[str, float], seed, name: str, min_adds=(2, 2, 4), max_frac=0.12, word_frac=0.04,
              refs: dict | None = None):
    """The transformed copy and the log of additions [(rule, kind, name)]. `refs` (from `referenced`) makes the twins
    those of names the sessions reference, most referenced first; without it they are drawn at random."""
    refs = refs or {"first": collections.Counter(), "container": collections.Counter(), "word": collections.Counter()}
    w = copy.deepcopy(world)
    log: list = []
    n0 = len(rows_of(w))
    budget = int(max_frac * n0)
    epoch = w.get("epoch", "2025-09-01T09:00")
    day0 = datetime.date.fromisoformat(epoch[:10])
    keys = {r["key"] for sec in SECTIONS for r in w.get(sec, []) if "key" in r}
    if any(k.startswith("col_") for k in keys):  # already a collision world: nothing to add
        return w, []

    def quiet(section: list) -> str:
        """The container the sessions reference least (a filed row must not change what a session reads in it)."""
        return min(section, key=lambda c: (refs["container"][c["name"].lower()], c["key"]))["key"]

    def key(prefix: str, i: int) -> str:
        k = f"col_{prefix}{i}"
        while k in keys:
            k += "x"
        keys.add(k)
        return k

    # 1. people sharing a first name
    r = rng(seed, name, "first")
    i = 0
    while len(log) < budget:
        m = measure(w)["first_name"]
        done = sum(1 for x in log if x[0] == "first")
        if m >= tgt["first_name"] and done >= min_adds[0]:
            break
        first = collections.Counter(p["name"].split()[0].lower() for p in w["people"])
        lone = [p for p in w["people"] if first[p["name"].split()[0].lower()] == 1 and p.get("key") != "me"
                and not p["name"].lower().startswith(("dr ", "mr ", "mrs "))]
        if not lone:
            break
        hit = sorted((p for p in lone if refs["first"][p["name"].split()[0].lower()]),
                     key=lambda p: (-refs["first"][p["name"].split()[0].lower()], p["name"]))
        src = hit[0] if hit else r.choice(sorted(lone, key=lambda p: p["name"]))
        used = {p["name"].lower() for p in w["people"]}
        sur = next((s for s in r.sample(SURNAMES, len(SURNAMES)) if f"{src['name'].split()[0]} {s}".lower() not in used), None)
        if not sur:
            break
        add_row(w, "people", {"key": key("p", i), "name": f"{src['name'].split()[0]} {sur}", "role": "acquaintance"}, log, "first")
        i += 1
    # 2. containers sharing a name across kinds
    r = rng(seed, name, "container")
    i = 0
    while len(log) < budget:
        m = measure(w)["container"]
        done = sum(1 for x in log if x[0] == "container")
        if m >= tgt["container"] and done >= min_adds[1]:
            break
        conts = [(k, n) for sec, k in SECTIONS.items() if k in CONTAINERS for n in [x["name"] for x in w.get(sec, [])]]
        kinds_of = collections.defaultdict(set)
        for k, n in conts:
            kinds_of[n.lower()].add(k)
        lone = sorted((k, n) for k, n in conts if len(kinds_of[n.lower()]) == 1)
        if not lone:
            break
        hit = sorted((x for x in lone if refs["container"][x[1].lower()]), key=lambda x: (-refs["container"][x[1].lower()], x))
        k, n = hit[0] if hit else r.choice(lone)
        twin = r.choice(sorted(set(TWIN_KINDS) - {k}))
        sec = TWIN_KINDS[twin]
        row = {"key": key("c", i), "name": n}
        if twin == "list":
            row["area"] = "home"
        add_row(w, sec, row, log, "container")
        i += 1
    # 3. rows of different kinds sharing a word
    r = rng(seed, name, "word")
    i = 0
    while len(log) < budget:
        m = measure(w)["shared_word"]
        done = sum(1 for x in log if x[0] == "word")
        if (m >= tgt["shared_word"] and done >= min_adds[2]) or done >= max(min_adds[2], int(word_frac * n0)):
            break
        wk = collections.defaultdict(set)
        for k, n in rows_of(w):
            for x in words(n):
                wk[x].add(k)
        pool = sorted({(x, next(iter(ks))) for x, ks in wk.items() if len(ks) == 1 and len(x) >= 4})
        if not pool:
            break
        hit = sorted((x for x in pool if refs["word"][x[0]]), key=lambda x: (-refs["word"][x[0]], x))
        word, kind0 = hit[0] if hit else r.choice(pool)
        kind, sec, tpl = r.choice([t for t in WORD_ROWS if t[0] != kind0])
        nm = tpl.format(w=word, W=word.capitalize())
        row = {"key": key("w", i), "name": nm}
        day = str(day0 - datetime.timedelta(days=7 + i))  # a free day before the epoch: no calendar conflict
        if kind == "task":
            row.update(status="cancelled", due=day)
        elif kind == "event":
            row.update(start=f"{day}T10:00", end=f"{day}T11:00", status="cancelled")
        elif kind == "note":  # filed, so "notes outside every notebook" does not change
            row.update(created=epoch, body="-")
            if w.get("notebooks"):
                row["notebook"] = quiet(w["notebooks"])
        elif kind == "document":
            row["created"] = epoch
            if w.get("folders"):
                row["folder"] = quiet(w["folders"])
        elif kind == "photo":
            row["taken"] = epoch
            if w.get("albums"):
                row["albums"] = [quiet(w["albums"])]
        elif kind == "locker item":
            row.update(type="note")
        add_row(w, sec, row, log, "word")
        i += 1
    return w, log


def verify(worlds: list[str], tdir: Path, sessions_dir: Path, jobs: int, out: Path) -> dict:
    """Build every session of the worlds on the original and on the transformed world; what no longer verifies."""
    base, coll = out / "_verify-base", out / "_verify-collide"
    common.build_many([(w, None) for w in worlds], sessions_dir, base, n_jobs=jobs)
    common.build_many([(w, None) for w in worlds], sessions_dir, coll, worlds_dir=tdir, n_jobs=jobs)
    result = {}
    for w in worlds:
        b, c = common.read_report(base, w), common.read_report(coll, w)
        broke = [sid for sid, e in b.items() if e["pass"] and not c.get(sid, {"pass": False})["pass"]]
        amb, other = [], []
        for sid in broke:
            text = json.dumps(c[sid]["problems"])
            (amb if re.search(r"ambiguous|\bask\b|candidates", text) else other).append(sid)
        result[w] = {"sessions": len(b), "verified_before": sum(e["pass"] for e in b.values()),
                     "verified_after": sum(e["pass"] for e in c.values()), "broke": len(broke),
                     "broke_ambiguous": amb, "broke_other": other}
    return result


def seed_keys(worlds: list[str], out: Path) -> None:
    """Seed each world written to `out` with the runtime and write its keys file beside it (eval/seed_worlds.py)."""
    import contextlib
    import io
    import tempfile

    import lib
    import seed_worlds

    lib.WORLDS = out  # world_dir(W) is `out`, so the keys file is written beside the world file
    with tempfile.TemporaryDirectory(prefix="collide-vaults-") as vaults, contextlib.redirect_stdout(io.StringIO()):
        for w in worlds:
            seed_worlds.seed(w, Path(vaults))
    print(f"keys: {len(worlds)} keys files written to {out}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path)
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--worlds", default="train")
    ap.add_argument("--profile", default="abc", choices=["abc", "mean", "d"])
    ap.add_argument("--min-adds", default="2,2,4")
    ap.add_argument("--max-add-frac", type=float, default=0.12)
    ap.add_argument("--word-frac", type=float, default=0.04, help="shared-word rows: at most this share of the world's rows")
    ap.add_argument("--seed", default="1044")
    ap.add_argument("--random", action="store_true", help="twin random rows instead of the names the sessions reference")
    ap.add_argument("--keys", action="store_true", help="also seed each written world and write DIR/<W>.keys.json (needs NATIVETOOLS)")
    ap.add_argument("--verify", nargs="?", const="T01,T10")
    ap.add_argument("--sessions-dir", type=Path, default=AUTHORED / "sessions")
    ap.add_argument("--jobs", type=int, default=4)
    a = ap.parse_args()
    worlds = common.TRAIN_WORLDS if a.worlds == "train" else a.worlds.split(",")
    tgt = targets(a.profile)
    print("targets", {k: round(v, 3) for k, v in tgt.items()})
    mins = tuple(int(x) for x in a.min_adds.split(","))
    tot = collections.Counter()
    for w in worlds:
        src = json.loads((AUTHORED / "worlds" / f"{w}.json").read_text())
        refs = None if a.random else referenced(w, a.sessions_dir)
        new, log = transform(src, tgt, a.seed, w, mins, a.max_add_frac, a.word_frac, refs)
        b, f = measure(src), measure(new)
        c = collections.Counter(x[0] for x in log)
        tot.update(c)
        print(f"{w}: +{len(log)} rows {dict(c)}  " + "  ".join(f"{k} {b[k]:.2f}->{f[k]:.2f}" for k in b))
        if a.out and not a.dry:
            a.out.mkdir(parents=True, exist_ok=True)
            (a.out / f"{w}.json").write_text(json.dumps(new, indent=1, ensure_ascii=False))
    print("added", dict(tot), "rows:", sum(tot.values()))
    if a.keys and a.out and not a.dry:
        seed_keys(worlds, a.out)
    if a.verify and a.out and not a.dry:
        res = verify(a.verify.split(","), a.out, a.sessions_dir, a.jobs, a.out)
        (a.out / "collide.verify.json").write_text(json.dumps(res, indent=1))
        for w, r in res.items():
            print(f"{w}: sessions {r['sessions']}, verified {r['verified_before']} -> {r['verified_after']}, broke {r['broke']} "
                  f"(ambiguous {len(r['broke_ambiguous'])}, other {len(r['broke_other'])})")


if __name__ == "__main__":
    main()
