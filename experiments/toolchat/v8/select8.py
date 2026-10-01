"""v8: pick which trajectories to paraphrase, and how many rows each should make.

    python3 v8/select8.py [--traj v8/traj.jsonl] [--out v8/selected8.jsonl] [--rows 4500]
    python3 v8/select8.py --topup v8/train8.jsonl --out v8/topup8.jsonl   # after a build

Every val session (w37-w40) is kept whole. Train sessions:
1. tails trimmed: trailing turns tagged ONLY with over-covered skills (the
   pool would give them >= --over x their BASELINE target) are cut -- a
   session's tail can go without changing what the earlier turns showed.
   A minimal-pair turn, a recovery turn and a back-to turn are never cut.
2. forced: both halves of every minimal pair, every session with a recovery
   turn, every session with a back-to turn (at the minimum multiplier).
3. greedy: each step adds the session (or raises a chosen session's
   multiplier by half a row) whose expected rows fill the most remaining
   skill deficit per row -- deficit = BASELINE target minus expected rows,
   expected rows of a skill = multiplier x --survival x turns carrying it;
   a skill still under --min-worlds worlds scores a new world's rows double.
4. fill: while under --rows, add unselected sessions whose rarest skill is
   rarest in the pool.
Each record keeps its trajectory fields and gains `mult` (rows to build from
it; build8.py spreads them over the paraphrased versions).

--topup reads a built train8.jsonl, counts the real rows per skill, and for
the skills still short (step 3 only) raises the multiplier of sessions
already paraphrased (--exclude, no Opus cost) or adds new ones; --out gets
the whole updated selection (make_batches8.py batches only the new ids).
"""
import argparse
import collections
import heapq
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [HERE]


def targets(path):
    tg = {}
    pat = re.compile(r"^\| `([a-z_]+\.[a-z_]+)` \| (\w+) \| \d+ \| \d+ \| \d+ \| (\d+) \|\s*$")
    for line in open(path, encoding="utf-8"):
        m = pat.match(line)
        if m:
            tg[m.group(1)] = int(m.group(3))
    return tg


def protected(t):
    return bool(t.get("pair") or t.get("recovery") or t["hint"].lower().startswith("back to"))


def trim(rec, over):
    turns = list(rec["turns"])
    while len(turns) > 1 and not protected(turns[-1]) and set(turns[-1]["skills"]) <= over:
        turns.pop()
    return dict(rec, turns=turns)


def counts(rec):
    c = collections.Counter()
    for t in rec["turns"]:
        c.update(set(t["skills"]))
    return c


def pair_of(rec):
    for t in rec["turns"]:
        if t.get("pair"):
            return t["pair"].rsplit("/", 1)[0]
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--traj", default=os.path.join(HERE, "traj.jsonl"))
    ap.add_argument("--out", default=os.path.join(HERE, "selected8.jsonl"))
    ap.add_argument("--baseline", default=os.path.join(HERE, "BASELINE.md"))
    ap.add_argument("--rows", type=float, default=4500, help="train rows wanted after the leakage strip")
    ap.add_argument("--survival", type=float, default=0.8, help="share of built turns the leakage strip keeps")
    ap.add_argument("--row-survival", type=float, default=0.95, help="share of built rows the strip keeps")
    ap.add_argument("--over", type=float, default=4.0, help="over-covered: pool gives >= this x target")
    ap.add_argument("--min-mult", type=float, default=2.0)
    ap.add_argument("--max-mult", type=float, default=4.0)
    ap.add_argument("--val-mult", type=float, default=2.5)
    ap.add_argument("--min-worlds", type=int, default=10)
    ap.add_argument("--topup", default="", help="built train8.jsonl: select more for the skills it leaves short")
    ap.add_argument("--exclude", default="", help="comma-separated selected*.jsonl whose ids are taken already")
    ap.add_argument("--headroom", type=float, default=1.1, help="top-up aims at target x this")
    a = ap.parse_args()

    tg = targets(a.baseline)
    recs = [json.loads(l) for l in open(a.traj, encoding="utf-8") if l.strip()]
    train = [r for r in recs if r["split"] == "train"]
    val = [r for r in recs if r["split"] == "val"]
    taken = set()
    for f in filter(None, a.exclude.split(",")):
        taken |= {json.loads(l)["id"] for l in open(f, encoding="utf-8") if l.strip()}

    pool = collections.Counter()
    for r in train:
        pool.update(counts(r))
    y0 = 2.5 * a.survival
    over = {s for s in tg if pool[s] * y0 >= a.over * tg[s]}

    have = collections.Counter()
    have_worlds = collections.defaultdict(set)
    if a.topup:
        for l in open(a.topup, encoding="utf-8"):
            r = json.loads(l)
            for sk in r["skills"]:
                for s in sk:
                    have[s] += 1
                    have_worlds[s].add(r["world"].replace(".json", ""))
        deficit = {s: max(0.0, tg[s] * a.headroom - have[s]) for s in tg}
    else:
        deficit = {s: float(tg[s]) for s in tg}
    worlds = {s: set(have_worlds[s]) for s in tg}

    cand = [trim(r, over) for r in train if r["id"] not in taken]
    mult = {}
    prior = []
    if a.topup:
        # sessions already paraphrased: raising their multiplier costs no
        # paraphrase, only more augmented rows; their rows are in `have`
        for f in filter(None, a.exclude.split(",")):
            prior += [json.loads(l) for l in open(f, encoding="utf-8") if l.strip()]
        cand += [r for r in prior if r["split"] == "train"]
        mult = {r["id"]: r["mult"] for r in prior if r["split"] == "train"}
    by_id = {r["id"]: r for r in cand}
    cnt = {r["id"]: counts(r) for r in cand}
    start = dict(mult)

    def credit(rid, dm):
        r = by_id[rid]
        for s, n in cnt[rid].items():
            if s in deficit:
                deficit[s] -= dm * a.survival * n
                worlds[s].add(r["world"])

    def gain(rid, dm):
        r = by_id[rid]
        g = 0.0
        for s, n in cnt[rid].items():
            if s not in deficit or deficit[s] <= 0:
                continue
            e = min(deficit[s], dm * a.survival * n)
            if len(worlds[s]) < a.min_worlds and r["world"] not in worlds[s]:
                e *= 2
            g += e
        return g / dm

    # 2. forced
    forced = collections.Counter()
    if not a.topup:
        pairs = collections.defaultdict(list)
        for r in cand:
            p = pair_of(r)
            if p:
                pairs[p].append(r["id"])
        for r in cand:
            why = ("pair" if pair_of(r) else
                   "recovery" if any(t.get("recovery") for t in r["turns"]) else
                   "back-to" if any(t["hint"].lower().startswith("back to") for t in r["turns"]) else None)
            if why:
                mult[r["id"]] = a.min_mult
                credit(r["id"], a.min_mult)
                forced[why] += 1
        # a pair travels whole
        for ids in pairs.values():
            for i in ids:
                if i not in mult:
                    mult[i] = a.min_mult
                    credit(i, a.min_mult)

    budget = a.rows / a.row_survival

    # 3. greedy with lazy re-evaluation
    def step_of(rid):
        return a.min_mult if rid not in mult else 0.5

    if a.topup:
        budget = float("inf")
    heap = [(-gain(rid, step_of(rid)), rid) for rid in by_id if mult.get(rid, 0) < a.max_mult]
    heapq.heapify(heap)
    while heap and sum(mult.values()) < budget and any(v > 0 for v in deficit.values()):
        ng, rid = heapq.heappop(heap)
        if mult.get(rid, 0) >= a.max_mult:
            continue
        dm = step_of(rid)
        g = gain(rid, dm)
        if g <= 1e-9:
            continue
        if heap and g < -heap[0][0] - 1e-9:
            heapq.heappush(heap, (-g, rid))
            continue
        mult[rid] = mult.get(rid, 0) + dm
        credit(rid, dm)
        if mult[rid] < a.max_mult:
            heapq.heappush(heap, (-gain(rid, 0.5), rid))

    need_rows = sum(mult.values())
    need_sessions = len(mult)
    # 4. fill with the rarest-skill sessions
    filled = 0
    if not a.topup:
        rest = sorted((rid for rid in by_id if rid not in mult),
                      key=lambda rid: min((pool[s] for s in cnt[rid] if s in tg), default=10 ** 9))
        for rid in rest:
            if sum(mult.values()) + a.min_mult > budget:
                break
            mult[rid] = a.min_mult
            credit(rid, a.min_mult)
            filled += 1

    out = [dict(by_id[rid], mult=m) for rid, m in mult.items()]
    if not a.topup:
        out += [dict(r, mult=a.val_mult) for r in val]
    else:
        out += [r for r in prior if r["split"] != "train"]
        raised = sum(1 for rid in start if mult[rid] > start[rid])
        new = [rid for rid in mult if rid not in start]
        print("top-up: %d paraphrased sessions raised (+%.1f rows), %d new sessions to paraphrase (+%.1f rows)"
              % (raised, sum(mult[r] - start[r] for r in start), len(new), sum(mult[r] for r in new)))
    out.sort(key=lambda r: r["id"])
    with open(a.out, "w", encoding="utf-8") as fh:
        for r in out:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")

    sel = [r for r in out if r["split"] == "train"]
    exp = collections.Counter()
    ew = collections.defaultdict(set)
    for r in sel:
        for s, n in counts(r).items():
            exp[s] += (r["mult"] - start.get(r["id"], 0)) * a.survival * n
            ew[s].add(r["world"])
    rows = sum(r["mult"] for r in sel)
    turns = sum(len(r["turns"]) * r["mult"] for r in sel)
    trimmed = sum(len(r["turns"]) for r in train if r["id"] in mult) - sum(len(r["turns"]) for r in sel)
    print("over-covered (tails trimmed): %s" % ", ".join(sorted(over)))
    print("selected %d train sessions (%d trailing turns trimmed; forced %s; filled %d) + %d val sessions -> %s"
          % (len(sel), trimmed, dict(forced), filled, len([r for r in out if r["split"] == "val"]), a.out))
    print("targets met at %.0f built rows (%d sessions) before the fill" % (need_rows, need_sessions))
    print("multipliers: %s" % dict(sorted(collections.Counter(r["mult"] for r in sel).items())))
    print("expected train rows %.0f built, %.0f after the strip; %.0f turns built (%.2f per row)"
          % (rows, rows * a.row_survival, turns, turns / max(rows, 1)))
    base = have if a.topup else collections.Counter()
    short = [(s, base[s] + exp[s], tg[s], len(ew[s] | worlds[s])) for s in sorted(tg)
             if base[s] + exp[s] < tg[s] or len(ew[s] | worlds[s]) < a.min_worlds]
    print("expected SHORT after selection: %d%s" % (len(short), "".join(
        "\n  %-22s %.0f / %d  (%d worlds)" % x for x in short)))


if __name__ == "__main__":
    main()
