"""v8 look-first rewrite: every turn LOOKS, then acts BY HANDLE.

    python3 v8/lookfirst.py [--traj v8/traj.jsonl] [--out v8/traj-lf.jsonl] [--only-world w01,...]
                            [--ids ids.txt] [--identity]

Reads trajgen's sessions and rewrites each turn to one deterministic policy, then RE-PLAYS the
whole session through `tool-loop serve` (trajgen's Server), so every observation is the runtime's
own. A session is DROPPED (never repaired) when any rewritten call errors, a kept step's
observation changes, or a turn's verdict differs from the recorded one (same rows, same value,
same write echo, same decline).

The policy, per turn (T = the recorded turn, X = its final call):

- read, `answer <set>`:
  * X names rows by handle already (`answer #2, #5`): kept; a turn with no look first gets
    `show #2, #5` before it.
  * the rows X answers (1-8, none hidden) were all printed by a look in T: `answer #a, #b` --
    the rows picked from what the look showed.
  * otherwise a look is added, `show <set>` (the answer's own expression; reused when T's last
    look was exactly that), and the answer names its rows: `answer #a, #b` when it printed 1-8
    rows and hid none, else the answer REPEATS the look's expression (`answer <set>`) -- a
    result too large to list, or `no rows`.
- read, `answer <value>` (`count of (S)`, `sum F of (S)`, `F of (S)`, `balance of (A) in (B)`):
  * S names handles: kept; `show <those handles>` first when T has no look.
  * otherwise `show S` is added (or reused) and the value is taken over its rows by handle,
    `answer count of (#1, #2, #3)`, when it printed 1-8 rows; else over the same expression.
- judge `answer F of (S)` -> `ambiguous` -> `done` ("when is my dentist thing"): `show S`, then
  `answer F of (#a, #b)` (the runtime asks back), then `done`.
- judge `<write> on (parties called "F")` -> `ambiguous` -> `done`: `show (parties called "F")`,
  then `ask "Which F — <last> or <last>?"` (trajgen's own ask form); `group_id: (groups)` ->
  `show (groups)` and `ask "Which group — A or B?"`.
- judge `<write> on (<kind> called "x")` -> `no live rows; in the trash` -> `nothing`:
  `show (<kind> called "x")` (no rows), `show (<kind> called "x") that (deleted_at is not null)`
  (the trashed rows), `nothing` -- the recovery form trajgen already uses.
- write: a write that names rows (`on #4`, `group_id: (#5)`) in a turn with no look gets
  `show <those handles>` first. Creates that name nothing are kept.
- everything else (ask after a look, `nothing`, `refuse`, a no-link `ambiguous` -> `done`, the
  "the row you started from answers it" recovery) is kept. A recovery turn keeps its miss step
  (build8 masks it); the answer after the miss follows the rules above.

Handles move when a look is added (rows get numbered earlier), so every later `#n` is re-mapped:
the rows of a kept step are paired by position with the recorded ones, and the rows of a rewritten
step by their line text. A handle that cannot be mapped drops the session.

Output: the same records (same ids), steps replaced; each turn gains `lf`, the rule applied.
`--identity` replays the recorded calls unchanged (a determinism check).
"""
import argparse
import collections
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [HERE]
from trajgen import Server  # noqa: E402

HROW = re.compile(r"^#(\d+) (.*)$", re.M)
HANDLE = re.compile(r"#(\d+)\b")
HLIST = re.compile(r"^\(?#\d+(, #\d+)*\)?$")
LOOK = ("show ", "search ", "get ")
FIELDS = r"(?:amount_minor|owed_to_me_minor|owed_to_them_minor|dtstart|effort_min|due_at|spent_on|captured_at|started_at)"
MAX_LIST = 8


class Drop(Exception):
    pass


def norm(obs):
    return HANDLE.sub("#", obs)


def rows(obs):
    """[(handle, line text without the handle)] printed by an observation"""
    return [(int(n), txt) for n, txt in HROW.findall(obs)]


def hidden(obs):
    return "rows in all" in obs


def hs(ns):
    return ", ".join("#%d" % n for n in ns)


def close_paren(s, i):
    """index of the paren closing s[i] == '('"""
    d = 0
    for j in range(i, len(s)):
        if s[j] == "(":
            d += 1
        elif s[j] == ")":
            d -= 1
            if d == 0:
                return j
    return -1


def wrapped(s):
    """s is `( … )` with the outer parens a matched pair"""
    return s.startswith("(") and close_paren(s, 0) == len(s) - 1


def parse_value(expr):
    """-> (head, inner) with expr == head + "(" + inner + ")", or ("balance", (a, b)); None for a set"""
    m = re.match(r"^(count of |sum \w+ of |min \w+ of |max \w+ of |%s of )(\(.*\))$" % FIELDS, expr)
    if m and wrapped(m.group(2)):
        return m.group(1), m.group(2)[1:-1]
    m = re.match(r"^balance of (\(.*)$", expr)
    if m:
        rest = m.group(1)
        j = close_paren(rest, 0)
        if j > 0:
            a, tail = rest[:j + 1], rest[j + 1:]
            m2 = re.match(r"^ in (\(.*\))$", tail)
            if m2 and wrapped(m2.group(1)):
                return "balance", (a[1:-1], m2.group(1)[1:-1])
    return None


def handle_only(s):
    return bool(HLIST.match(s.strip()))


def handles_in(line):
    out = []
    for n in HANDLE.findall(line):
        if int(n) not in out:
            out.append(int(n))
    return out


class Replay:
    """one session played through the runtime; the recorded handles mapped to the replayed ones"""

    def __init__(self, srv, rec):
        self.srv = srv
        today = srv.ask({"op": "open"})["today"]
        if today != rec["today"]:
            raise Drop("today differs")
        self.map = {}        # recorded #n -> replayed #n
        self.back = {}       # replayed #n -> recorded #n
        self.steps = []      # this turn's replayed steps
        self.end = None

    def begin(self, hint):
        self.srv.ask({"op": "turn", "request": hint})
        self.steps = []
        self.end = None

    def remap(self, line):
        def one(m):
            n = int(m.group(1))
            if n not in self.map:
                raise Drop("unmapped handle")
            return "#%d" % self.map[n]
        # handles only outside quoted strings
        parts = re.split(r'("[^"]*")', line)
        return "".join(p if p.startswith('"') else HANDLE.sub(one, p) for p in parts)

    def raw(self, line):
        r = self.srv.ask({"op": "call", "line": line})
        if "error" in r:
            raise Drop("serve: %s" % r["error"])
        return r.get("obs", ""), r.get("end")

    def call(self, line, record=True, expect_error=False):
        if self.end:
            raise Drop("call after the turn ended")
        obs, end = self.raw(line)
        if obs.startswith("error:") and not expect_error:
            raise Drop("error: %s -> %s" % (line, obs[:80]))
        if record:
            self.steps.append({"call": line, "obs": obs})
        if end:
            self.end = end
        return obs

    def pair(self, n_rec, n_new):
        if self.map.get(n_rec, n_new) != n_new or self.back.get(n_new, n_rec) != n_rec:
            raise Drop("handle map conflict")
        self.map[n_rec] = n_new
        self.back[n_new] = n_rec

    def zip(self, obs_rec, obs_new):
        a, b = rows(obs_rec), rows(obs_new)
        if len(a) != len(b):
            raise Drop("row count differs")
        for (x, tx), (y, ty) in zip(a, b):
            if tx != ty:
                raise Drop("row text differs")
            self.pair(x, y)

    def match_text(self, rec_steps, new_steps):
        """map recorded rows not yet mapped to replayed rows of the same turn by line text"""
        new = collections.defaultdict(list)
        for st in new_steps:
            for n, t in rows(st["obs"]):
                if n not in new[t]:
                    new[t].append(n)
        for st in rec_steps:
            for n, t in rows(st["obs"]):
                if n in self.map:
                    continue
                cand = [m for m in new[t] if m not in self.back]
                if len(cand) == 1:
                    self.pair(n, cand[0])


def is_write(call):
    return bool(re.match(r"^[\w.]+\{", call))


def same_verdict(rec_turn, new_steps, end):
    """the replayed turn ends the way the recorded one did"""
    want = rec_turn.get("end")
    if end != want:
        raise Drop("verdict differs: %s vs %s" % (end, want))
    last_rec, last_new = rec_turn["steps"][-1], new_steps[-1]
    if want.startswith("ids"):
        a = sorted(t for _, t in rows(last_rec["obs"]))
        b = sorted(t for _, t in rows(last_new["obs"]))
        if a != b or hidden(last_rec["obs"]) != hidden(last_new["obs"]):
            raise Drop("answer rows differ")
    elif want == "wrote":
        if norm(last_rec["obs"]) != norm(last_new["obs"]):
            raise Drop("write echo differs")


def look_then(R, line_set):
    """`show (<set>)` (the set parenthesised unless it already is; as written when that does not
    parse) -> (the form shown, the step's obs)"""
    forms = (line_set,) if wrapped(line_set) else ("(%s)" % line_set, line_set)
    for form in forms:
        obs = R.call("show " + form, record=False, expect_error=True)
        if not obs.startswith("error:"):
            R.steps.append({"call": "show " + form, "obs": obs})
            return form, obs
    raise Drop("look does not parse: %s" % line_set)


def listable(obs):
    rs = rows(obs)
    return 1 <= len(rs) <= MAX_LIST and not hidden(obs)


def play_kept(R, st):
    """a recorded step replayed as is (handles re-mapped); its observation must not change"""
    line = R.remap(st["call"])
    obs = R.call(line, expect_error=st["obs"].startswith("error:"))
    if norm(obs) != norm(st["obs"]):
        raise Drop("kept step observation differs: %s" % st["call"][:40])
    R.zip(st["obs"], obs)
    return obs


def convert_turn(R, t, identity=False):
    steps = t["steps"]
    calls = [s["call"] for s in steps]
    if identity:
        for st in steps:
            play_kept(R, st)
        return "identity"
    last = calls[-1]
    # -- judge: X -> ambiguous -> done
    if last == "done" and len(steps) >= 2 and steps[-2]["obs"].startswith("ambiguous"):
        x = calls[-2]
        prefix = steps[:-2]
        if x.startswith("answer ") and "no link" not in steps[-2]["obs"] and "linked" not in steps[-2]["obs"]:
            pv = parse_value(x[len("answer "):])
            if pv and pv[0] != "balance" and not handle_only(pv[1]) and not prefix:
                head, inner = pv
                form, obs = look_then(R, R.remap(inner))
                if listable(obs):
                    o = R.call("answer %s(%s)" % (head, hs(n for n, _ in rows(obs))))
                else:       # too many to list: the value over the look's own expression
                    o = R.call("answer %s(%s)" % (head, form))
                if not o.startswith("ambiguous"):
                    raise Drop("value over handles not ambiguous")
                R.call("done")
                return "judge-value"
        if is_write(x) and not prefix:
            if "group_id: (groups)" in x:
                obs = R.call("show (groups)")
                names = [txt.split('"')[1] for n, txt in rows(obs) if txt.startswith("group ")]
                if len(names) < 2 or hidden(obs):
                    raise Drop("groups not listable")
                R.call('ask "Which group — %s?"' % (", ".join(names[:-1]) + " or " + names[-1]))
                return "judge-ask"
            m = re.search(r' on \(parties called "([^"]+)"\)$', x)
            if m:
                f = m.group(1)
                obs = R.call('show (parties called "%s")' % f)
                ps = [txt.split('"')[1] for n, txt in rows(obs) if txt.startswith("party ")]
                if len(ps) < 2 or hidden(obs):
                    raise Drop("clash not listable")
                R.call('ask "Which %s — %s?"' % (f, " or ".join(p.split()[-1] for p in ps)))
                return "judge-ask"
        for st in steps:
            play_kept(R, st)
        return "kept"
    # -- judge: a write on a name that only reaches trashed rows -> nothing
    if last == "nothing" and len(steps) == 2 and is_write(calls[0]) and steps[0]["obs"].startswith("no live rows"):
        m = re.search(r" on (\((\w[\w ]*) called \"[^\"]+\"\))$", calls[0])
        if not m:
            raise Drop("trashed write form")
        target = m.group(1)
        if R.call("show " + target) != "no rows":
            raise Drop("trashed target is live")
        R.call("show %s that (deleted_at is not null)" % target)
        R.call("nothing")
        return "judge-trash"
    # -- read: ... answer X
    if last.startswith("answer ") and t["kind"] in ("read", "judge"):
        prefix = steps[:-1]
        looked = any(c.startswith(LOOK) for c in calls[:-1])
        turn_rows_rec = set()
        for st in prefix:
            if st["call"].startswith(LOOK):
                turn_rows_rec |= {n for n, _ in rows(st["obs"])}
        for st in prefix:
            play_kept(R, st)
        x_rec = last[len("answer "):]
        x = R.remap(x_rec)
        rec_last = steps[-1]
        pv = parse_value(x)
        if pv:
            head, inner = pv
            if head == "balance" or handle_only(inner):
                if not looked:
                    R.call("show " + hs(handles_in(x)))
                R.call("answer " + x)
                return "value-kept" if looked else "value-look-handles"
            last_look = R.steps[-1]["call"] if R.steps and R.steps[-1]["call"].startswith("show ") else None
            if last_look in ("show " + inner, "show (%s)" % inner):
                obs = R.steps[-1]["obs"]
                rule = "value-reuse"
            else:
                _, obs = look_then(R, inner)
                rule = "value-look"
            if listable(obs):
                R.call("answer %s(%s)" % (head, hs(n for n, _ in rows(obs))))
                return rule + "-handles"
            R.call("answer " + x)
            return rule + "-repeat"
        # a set
        if handle_only(x):
            if not looked:
                R.call("show " + x)
            R.call("answer " + x)
            return "set-kept" if looked else "set-look-handles"
        ans_rec = [n for n, _ in rows(rec_last["obs"])]
        if (ans_rec and len(ans_rec) <= MAX_LIST and not hidden(rec_last["obs"])
                and all(n in turn_rows_rec for n in ans_rec)):
            want = {R.map[n] for n in ans_rec}
            order = [R.map[n] for n in ans_rec]
            for st in reversed(R.steps):     # the latest look that shows them all: in its order
                shown = [n for n, _ in rows(st["obs"])]
                if st["call"].startswith(LOOK) and want <= set(shown):
                    order = [n for n in dict.fromkeys(shown) if n in want]
                    break
            R.call("answer " + hs(order))
            return "set-pick"
        last_look = R.steps[-1]["call"] if R.steps and R.steps[-1]["call"].startswith("show ") else None
        if last_look == "show " + x:
            obs = R.steps[-1]["obs"]
            rule = "set-reuse"
        else:
            obs = R.call("show " + x)
            rule = "set-look"
        if listable(obs):
            R.call("answer " + hs(n for n, _ in rows(obs)))
            return rule + "-handles"
        R.call("answer " + x)
        return rule + ("-empty" if obs == "no rows" else "-repeat")
    # -- write
    if is_write(last) and t.get("end") == "wrote":
        looked = any(c.startswith(LOOK) for c in calls[:-1])
        for st in steps[:-1]:
            play_kept(R, st)
        line = R.remap(last)
        hh = handles_in(line)
        rule = "write-kept"
        if not looked and hh:
            R.call("show " + hs(hh))
            rule = "write-look-handles"
        R.call(line)
        return rule
    for st in steps:
        play_kept(R, st)
    return "kept"


def convert(srv, rec, identity=False):
    R = Replay(srv, rec)
    out = []
    for t in rec["turns"]:
        R.begin(t["hint"])
        rule = convert_turn(R, t, identity)
        if not R.end:
            raise Drop("turn left open")
        same_verdict(t, R.steps, R.end)
        R.match_text(t["steps"], R.steps)
        nt = dict(t, steps=R.steps, lf=rule)
        out.append(nt)
    return dict(rec, turns=out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--traj", default=os.path.join(HERE, "traj.jsonl"))
    ap.add_argument("--out", default=os.path.join(HERE, "traj-lf.jsonl"))
    ap.add_argument("--worlds", default=os.path.join(HERE, "worlds"))
    ap.add_argument("--only-world", default="")
    ap.add_argument("--ids", default="", help="file of session ids (one per line) to convert")
    ap.add_argument("--identity", action="store_true", help="replay unchanged (determinism check)")
    a = ap.parse_args()
    recs = [json.loads(l) for l in open(a.traj, encoding="utf-8") if l.strip()]
    if a.only_world:
        keep = set(a.only_world.split(","))
        recs = [r for r in recs if r["world"] in keep]
    if a.ids:
        keep = {l.strip() for l in open(a.ids) if l.strip()}
        recs = [r for r in recs if r["id"] in keep]
    by_world = collections.OrderedDict()
    for r in recs:
        by_world.setdefault(r["world"], []).append(r)
    drops, rules, kept = collections.Counter(), collections.Counter(), 0
    dropped_ids = []
    with open(a.out, "w", encoding="utf-8") as fh:
        for w, rs in by_world.items():
            srv = Server(os.path.join(a.worlds, w + ".json"))
            try:
                for rec in rs:
                    try:
                        new = convert(srv, rec, a.identity)
                    except Drop as exc:
                        key = re.sub(r"#\d+|\d+", "N", str(exc))
                        key = re.sub(r'"[^"]*"', '"…"', key)[:70]
                        drops[key] += 1
                        dropped_ids.append((rec["id"], str(exc)[:120]))
                        continue
                    for t in new["turns"]:
                        rules[t["lf"]] += 1
                    fh.write(json.dumps(new, ensure_ascii=False) + "\n")
                    kept += 1
            finally:
                srv.close()
            print("%s: %d sessions" % (w, len(rs)), file=sys.stderr, flush=True)
    print("sessions %d: converted %d, dropped %d" % (len(recs), kept, len(recs) - kept))
    print("\ndrop reasons:")
    for k, v in drops.most_common():
        print("  %5d  %s" % (v, k))
    print("\nturn rules:")
    for k, v in rules.most_common():
        print("  %5d  %s" % (v, k))
    if os.environ.get("LF_DROPS"):
        with open(os.environ["LF_DROPS"], "w") as fh:
            for i, why in dropped_ids:
                fh.write("%s\t%s\n" % (i, why))


if __name__ == "__main__":
    main()
