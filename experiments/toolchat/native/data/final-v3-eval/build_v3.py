"""Build the v3 corrected eval gold (val, test) from eval/sets/*.jsonl. Originals are not touched.

    python3 build_v3.py            # writes {val,test}.jsonl(.gz), CHANGES.md, variants-{val,test}.jsonl (validation only)

Effects for new accepted readings are DERIVED by running the variant reference calls through the runtime
(the same way eval/run.py --model ref verifies gold), so they are what the runtime really does.
"""
import copy, gzip, json, re, sys, hashlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
NATIVE = HERE.parents[1]
sys.path.insert(0, str(NATIVE / "eval"))
import run as R
from lib import read_jsonl, turn_effect
from score import Ids

AUDIT = json.load(open(NATIVE / "authored" / "conventions_audit.json"))
SETS = {n: read_jsonl(NATIVE / "eval" / "sets" / f"{n}.jsonl") for n in ("val", "test")}
NEW = copy.deepcopy(SETS)
IDX = {n: {s["id"]: s for s in NEW[n]} for n in NEW}
ORIG = {n: {s["id"]: s for s in SETS[n]} for n in SETS}
LOG = []          # (set, id, turn, change_no, old, new, reason)
VARIANT = {}      # (set, id, turn) -> alt ref, for the validation set
COUNTS = {}
ids_cache = {}


def ids(world):
    return ids_cache.setdefault(world, Ids(world))


def derive(setname, sid, turn, ref):
    """Effect of `ref` as turn `turn` (1-based) of the ORIGINAL session (earlier turns as authored)."""
    s = copy.deepcopy(ORIG[setname][sid])
    s["turns"] = s["turns"][:turn]
    s["turns"][-1]["ref"] = ref
    rec = R.run_session(s, R.RefBackend())
    created = []
    for tr in rec["turns"][:-1]:
        for st in tr["steps"]:
            for row in ((st["response"].get("effect") or {}).get("created") or []):
                created.append(row["id"])
    eff = turn_effect(rec["turns"][-1]["steps"])
    eff["_created"] = created
    return eff, s["world"]


def gold_from_effect(eff, world, like):
    i = ids(world)
    if eff["kind"] == "rows":
        def key(r):
            if r in i.by_id:
                return i.by_id[r]
            if r in eff["_created"]:
                return "+%d" % (eff["_created"].index(r) + 1)
            raise SystemExit(f"unkeyed row {r} in {like}")
        g = {"type": "rows", "rows": [key(r) for r in eff["rows"]]}
        if like.get("order"):
            g["order"] = True
    elif eff["kind"] == "value":
        v = eff["value"]
        g = {"type": "value"}
        if "groups" in v:
            g["groups"] = {str(x["key"]): x["values"] for x in v["groups"]}
        else:
            g["values"] = [{"amount": x["amount"], "unit": x.get("unit")} for x in v["values"]]
    else:
        raise SystemExit(f"cannot turn {eff['kind']} effect into gold")
    if like.get("diff"):
        g["diff"] = like["diff"]
    return g


def diff_gold(eff, world):
    i = ids(world)
    rows = []
    for r in eff["diff"]["rows"]:
        assert r["change"] == "trashed", r
        rows.append({"key": i.by_id[r["id"]], "change": "trashed"})
    return {"type": "diff", "diff": {"rows": rows, "links": []}}


def canon(g):
    g = copy.deepcopy(g)
    if g["type"] == "rows" and not g.get("order"):
        g["rows"] = sorted(g["rows"])
    return json.dumps(g, sort_keys=True)


def turn_of(setname, sid, turn):
    return IDX[setname][sid]["turns"][turn - 1]


def log(setname, sid, turn, change, old, new, reason):
    LOG.append(dict(set=setname, id=sid, turn=turn, change=change, old=old, new=new, reason=reason))
    COUNTS.setdefault(change, []).append((setname, sid, turn))


def short(g):
    s = json.dumps(g, ensure_ascii=False)
    return s if len(s) < 160 else f"{g['type']} ({len(s)} chars: {len(g.get('rows') or g.get('diff', {}).get('rows') or [])} rows)"


# ---- (1) status: add `= open` reading -----------------------------------------------------------
SUB_Q = re.compile(r'status in \(\\?"open\\?", \\?"in_progress\\?"\)')
SUB_U = re.compile(r"status in \(open, in_progress\)")


def sub_status(x):
    if isinstance(x, str):
        x = SUB_Q.sub(lambda m: 'status = \\"open\\"' if '\\"' in m.group(0) else 'status = "open"', x)
        return SUB_U.sub("status = open", x)
    if isinstance(x, list):
        return [sub_status(y) for y in x]
    if isinstance(x, dict):
        return {k: sub_status(v) for k, v in x.items()}
    return x


STATUS_SKIPPED = []
for setname in ("val", "test"):
    for sid, turn in AUDIT["families"]["a_task_status"]["variants"]["in_open_in_progress"]["turns"][setname]:
        t = turn_of(setname, sid, turn)
        if len(t["gold"]) != 1:
            STATUS_SKIPPED.append((setname, sid, turn, "already multi-accept"))
            continue
        alt_ref = sub_status(copy.deepcopy(ORIG[setname][sid]["turns"][turn - 1]["ref"]))
        assert alt_ref != t["ref"], (sid, turn)
        eff, world = derive(setname, sid, turn, alt_ref)
        new_g = gold_from_effect(eff, world, t["gold"][0])
        VARIANT[(setname, sid, turn)] = alt_ref
        if canon(new_g) == canon(t["gold"][0]):
            STATUS_SKIPPED.append((setname, sid, turn, "= open gives the same effect; gold unchanged"))
            continue
        t["gold"].append(new_g)
        log(setname, sid, turn, "1 status", short(t["gold"][0]) + " (single accept)",
            "accepts also: " + short(new_g), "add `status = open` reading as second accepted effect")

# follow-up that depends on the `= open` result of the turn before it (found by running the variants set)
t = turn_of("test", "dev-A-066", 2)
s = copy.deepcopy(ORIG["test"]["dev-A-066"]); s["turns"] = s["turns"][:2]
s["turns"][0]["ref"] = VARIANT[("test", "dev-A-066", 1)]
rec = R.run_session(s, R.RefBackend())
eff = turn_effect(rec["turns"][-1]["steps"]); eff["_created"] = []
new_g = gold_from_effect(eff, s["world"], t["gold"][0])
if canon(new_g) not in [canon(g) for g in t["gold"]]:
    t["gold"].append(new_g)
    log("test", "dev-A-066", 2, "1b status follow-up", short(t["gold"][0]) + " (single accept)", "accepts also: " + short(new_g),
        "'which of those is due first' follows turn 1; under the `= open` reading of turn 1 the set differs")

# ---- (2) document-send declines -------------------------------------------------------------------
for sid in ("dev-A-016", "dev-D-027", "test-B-009", "test-C-015"):
    t = turn_of("test", sid, 1)
    g = t["gold"][0]
    assert g["type"] == "decline" and g["reasons"] == ["sealed_egress"], g
    g["reasons"] = ["sealed_egress", "out_of_scope"]
    log("test", sid, 1, "2 doc-send decline", 'decline reasons ["sealed_egress"]', 'decline reasons ["sealed_egress", "out_of_scope"]',
        "sending a document/scan is out_of_scope in train and val; accept both")

# ---- (3) balance flip -----------------------------------------------------------------------------
for sid, turn, key in (("T03-095", 2, "$miguel"), ("T23-074", 4, "$malika_t")):
    t = turn_of("val", sid, turn)
    old = short(t["gold"][0]) + " | ref " + json.dumps(t["ref"])
    ref = [{"tool": "answer", "args": {"op": "balance", "rows": key}}]
    eff, world = derive("val", sid, turn, ref)
    new_g = gold_from_effect(eff, world, {})
    t["ref"] = ref
    t["gold"] = [new_g]
    t["tags"] = sorted(set(t.get("tags", [])) | {"convention", "convention:balance"})
    log("val", sid, turn, "3 balance flip", old, short(new_g) + " | ref " + json.dumps(ref), "'owe' question answers the balance value (SPEC 14.1)")

# ---- (4) date repair ------------------------------------------------------------------------------
def wk(rel, weekday, time=None):
    d = {"unit": "week", "rel": rel, "weekday": weekday}
    if time:
        d["time"] = time
    return d


def jd(d):
    return json.dumps(d, separators=(",", ":"))


def set_when(sid, turn, setname, when_new, as_string):
    t = turn_of(setname, sid, turn)
    call = next(c for c in t["ref"] if not c.get("bad") and "when" in c["args"])
    old = call["args"]["when"]
    call["args"]["when"] = jd(when_new) if as_string else when_new
    return old if isinstance(old, str) else jd(old), call["args"]["when"] if isinstance(call["args"]["when"], str) else jd(call["args"]["when"])


DATE_FIX = []
def date_log(setname, sid, turn, old, new):
    log(setname, sid, turn, "4 date repair", "ref " + old, "ref " + new, "ISO date written for a weekday/relative phrase (SPEC 4.4 gold form); effect unchanged")


# create events: rewrite the `date:` line of the args string
for sid, turn, rel, wd, t0, t1 in (("T03-021", 1, 0, 5, "18:00", "18:30"), ("T03-069", 1, 0, 6, "11:30", "12:00")):
    t = turn_of("val", sid, turn)
    call = t["ref"][0]
    old = call["args"]["args"]
    lines = old.split("\n")
    i = next(k for k, l in enumerate(lines) if l.startswith("date:"))
    lines[i] = "date: " + jd({"from": wk(rel, wd, t0), "to": wk(rel, wd, t1)})
    call["args"]["args"] = "\n".join(lines)
    date_log("val", sid, turn, old.split("\n")[i], lines[i])

def fix(setname, sid, turn, when, as_string):
    o, n = set_when(sid, turn, setname, when, as_string)
    date_log(setname, sid, turn, o, n)

fix("val", "T03-100", 7, {"from": wk(0, 1), "to": wk(0, 5, "12:00")}, True)
fix("val", "T12-005", 3, {"from": {"unit": "day", "rel": 1}, "to": wk(0, 7)}, True)
fix("val", "T12-063", 3, {"from": {"unit": "week", "rel": -1}, "to": wk(-1, 5, "12:00")}, True)
fix("val", "T12-098", 5, {"from": {"unit": "week", "rel": -1}, "to": wk(-1, 4, "21:00")}, True)
fix("val", "T23-010", 3, {"from": wk(0, 6, "09:00")}, False)
fix("val", "T23-039", 1, {"from": wk(-1, 6), "to": wk(-1, 7, "18:00")}, False)
fix("val", "T23-086", 2, {"from": wk(-1, 6), "to": wk(-1, 7, "18:00")}, False)
fix("test", "dev-A-064", 2, wk(-1, 7), False)

# ---- (5) rulings ---------------------------------------------------------------------------------
for sid, turn in (("T12-129", 3), ("T12-127", 3), ("T23-113", 4)):
    t = turn_of("val", sid, turn)
    g = t["gold"][0]
    assert g["type"] == "decline" and g["reasons"] == ["fabricated_secret"], g
    old = json.dumps({"gold": g["reasons"], "ref": t["ref"][-1]["args"]["reason"]})
    g["reasons"] = ["not_found"]
    assert t["ref"][-1]["tool"] == "decline"
    t["ref"][-1]["args"]["reason"] = "not_found"
    log("val", sid, turn, "5a plain secret lookup -> not_found", old, json.dumps({"gold": g["reasons"], "ref": "not_found"}),
        "ruling: a plain lookup with no 'guess' phrase is not_found")

t = turn_of("test", "test-D-080", 1)
assert any(g["type"] == "diff" for g in t["gold"][1:])
STATUS_SKIPPED.append(("test", "test-D-080", 1, "(5b) already accepts the scoped delete diff; no edit"))

t = turn_of("test", "dev-A-106", 1)
ref = [{"tool": "find", "args": {"kind": "person", "exclude": "$tomas"}}, {"tool": "act", "args": {"verb": "delete", "rows": "@prev"}}]
eff, world = derive("test", "dev-A-106", 1, ref)
g = diff_gold(eff, world)
t["gold"].append(g)
VARIANT[("test", "dev-A-106", 1)] = ref
log("test", "dev-A-106", 1, "5b scoped bulk delete acts", short(t["gold"][0]), "accepts also: " + short(g),
    "ruling: a scoped bulk delete ('all but tomas') is acted on; decline kept accepted")


# ---- (6) open-ended spans: sentinel dates -> SPEC 4.4 {"from":..} / {"to":..} -----------------------
def is_sent(d, pat):
    return isinstance(d, dict) and set(d) == {"date"} and re.fullmatch(pat, d["date"]) is not None


def desentinel(x):
    """Drop a sentinel end of a span ({"date":"2000-01-01"} as from, {"date":"2030-xx-xx"} as to)."""
    if isinstance(x, list):
        return [desentinel(y) for y in x]
    if isinstance(x, dict):
        x = {k: desentinel(v) for k, v in x.items()}
        if set(x) == {"from", "to"}:
            if is_sent(x["from"], r"2000-01-01"):
                return {"to": x["to"]}
            if is_sent(x["to"], r"2030-\d\d-\d\d"):
                return {"from": x["from"]}
        return x
    return x


def same_effect(a, b):
    keys = ("kind", "rows", "ordered", "value", "diff", "already", "revealed", "verbs")
    return all(a.get(k) == b.get(k) for k in keys)


for setname in ("val", "test"):
    for sess in NEW[setname]:
        for ti, t in enumerate(sess["turns"], 1):
            nref = desentinel(t["ref"])
            if nref == t["ref"]:
                continue
            # replay both forms (earlier turns as authored) and require the identical effect
            e0, _ = derive(setname, sess["id"], ti, t["ref"])
            e1, _ = derive(setname, sess["id"], ti, nref)
            assert same_effect(e0, e1), (setname, sess["id"], ti)
            oldw = json.dumps([c["args"].get("when") for c in t["ref"] if isinstance(c.get("args"), dict) and "when" in c["args"]])
            neww = json.dumps([c["args"].get("when") for c in nref if isinstance(c.get("args"), dict) and "when" in c["args"]])
            t["ref"] = nref
            log(setname, sess["id"], ti, "6 open-span sentinel", "ref when " + oldw, "ref when " + neww,
                "sentinel date (2000-01-01 / 2030-xx-xx) rewritten to the SPEC 4.4 open-ended span form; replayed effect identical")

# ---- (7) dev-A-106#2: follow-up to the scoped bulk delete -----------------------------------------
# Under the act reading of turn 1 ('all contacts except tomas' is deleted) Jordan Lee is already in
# the trash, so 'fine, just delete jordan lee' is a no-op: the runtime answers "no live person called
# Jordan Lee ... nothing was done". Accept the no-op diff (precedent: test-D-035) or a not_found decline.
t = turn_of("test", "dev-A-106", 2)
old = short(t["gold"][0])
t["gold"].append({"type": "diff", "diff": {"rows": [], "links": []}})
t["gold"].append({"type": "decline", "reasons": ["not_found"]})
log("test", "dev-A-106", 2, "7 bulk-delete follow-up", old + " (single accept)",
    'accepts also: empty diff (no-op) | decline ["not_found"]',
    "under the act reading of turn 1 Jordan is already trashed; the delete is a no-op")


# ---- (6b) runtime grounding artifact exposed by (6) -----------------------------------------------
# The sentinel `to: 2030-12-31` of test-B-086#1 made the runtime's grounding context read "later"
# (ground.rs context.later), which suppressed its weekday repair on turn 2. With the SPEC open-ended span
# the repair fires: "friday dec 11 at 8pm" with the call's own 2026-12-11 is rewritten to the nearest Friday,
# 2026-12-04. The replayed effect is therefore the Dec 4 row; accept it alongside the Dec 11 row.
t = turn_of("test", "test-B-086", 2)
g0 = t["gold"][0]
assert g0["diff"]["rows"][0]["fields"]["date"] == "2026-12-11T20:00"
g1 = copy.deepcopy(g0)
g1["diff"]["rows"][0]["fields"]["date"] = "2026-12-04T20:00"
t["gold"].append(g1)
log("test", "test-B-086", 2, "6b grounding artifact", "gold date 2026-12-11T20:00 (single accept)",
    "accepts also: date 2026-12-04T20:00",
    "after the open-ended span in turn 1 the runtime's weekday grounding rewrites 'friday dec 11' to Fri 2026-12-04 (runtime quirk); accept both")

# ---- write ---------------------------------------------------------------------------------------
for name in NEW:
    for s in NEW[name]:
        s["set"] = name
    text = "".join(json.dumps(s, ensure_ascii=False) + "\n" for s in NEW[name])
    (HERE / f"{name}.jsonl").write_text(text, encoding="utf-8")
    with gzip.GzipFile(HERE / f"{name}.jsonl.gz", "wb", mtime=0) as f:
        f.write(text.encode())
    # validation set: edited sessions with the variant refs swapped in (scored against the new gold)
    vs = copy.deepcopy(NEW[name])
    for (sn, sid, turn), alt in VARIANT.items():
        if sn == name:
            next(s for s in vs if s["id"] == sid)["turns"][turn - 1]["ref"] = alt
    (HERE / f"variants-{name}.jsonl").write_text("".join(json.dumps(s, ensure_ascii=False) + "\n" for s in vs), encoding="utf-8")
json.dump({"log": LOG, "skipped": STATUS_SKIPPED}, open(HERE / "changes.json", "w"), indent=1, ensure_ascii=False)
print({k: len(v) for k, v in COUNTS.items()}, "skipped", len(STATUS_SKIPPED))
for s in STATUS_SKIPPED: print(s)
