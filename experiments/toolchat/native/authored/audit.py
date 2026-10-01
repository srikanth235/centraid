"""Label audit of the authored train worlds: does the data teach one behaviour per convention?

    python3 authored/audit.py [--gold GLOB] [--records GLOB] [--near] [--json OUT] [-v]

Reads only the train worlds (authored/split.py drops the val worlds), SPEC.md section 14, BRIEF.md,
GAPBRIEF.md and eval/sets/val.jsonl (for the exact-duplicate check). It never reads eval/sets/test.jsonl.
Inputs are build.py outputs: OUT/<W>.gold.jsonl (sessions) and OUT/<W>.jsonl.gz (records, for the trace
checks). Prints one table, then the number of red rows; the goal is 0. `--near` also embeds every train
message with bge-small (run it with the ft interpreter, HF_HUB_OFFLINE=1) and lists near-duplicates of val
messages; that row is informational and never red.

Rows
  stated.<c>       the convention is written in SPEC section 14 and in BRIEF.md, in the same words
  outcome.<c>      every turn that fires the convention ends in the outcome the rule says (wifi, diary,
                   balance), or, for the date rules, no ask decides what the rule already decides and
                   the date the call uses is the date the rule gives
  ambiguity.*      a bare-name write that the runtime accepted although two rows of its kind fit in the
                   context (none); the share of turns the runtime answered `ambiguous` (3 to 7%, GOALS 3)
  vocabulary.*     users say delete for the action, trash only for the place; the briefs say so too
  hygiene.*        exact duplicates of val messages (six words or more) in train
"""
from __future__ import annotations

import argparse
import datetime
import glob
import gzip
import json
import re
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
NATIVE = HERE.parent
sys.path[:0] = [str(NATIVE / "eval"), str(HERE)]
import conventions  # noqa: E402
import split  # noqa: E402

CONVENTIONS = ["next_weekday", "weekend", "week", "at_n", "last_month_name", "bare_weekday", "diary", "wifi", "balance"]
WEEKDAYS = {"monday": 1, "tuesday": 2, "wednesday": 3, "thursday": 4, "friday": 5, "saturday": 6, "sunday": 7}

# -- what SPEC section 14 and BRIEF.md must both say, per convention (every pattern must match) ------------
STATED = {
    "next_weekday": [r'next (?:monday|friday)"?\s*(?:=|is)\s*(?:the )?(?:Monday|Friday) of next week'],
    "weekend": [r'this weekend"[^.\n]{0,40}(?:=|is|are)[^.\n]*(?:coming Sat|Saturday and Sunday|Sat–Sun)'],
    "week": [r"(?:weeks start Monday|weeks run Monday to Sunday|a week is Monday to Sunday)"],
    "at_n": [r"(?:1\.\.7|1 to 7)\s*(?:=|is)\s*pm"],
    "last_month_name": [r'last november"?\s*(?:=|is)\s*(?:the )?most recent'],
    "bare_weekday": [r'(?:bare weekday[^.\n]*next occurrence|"friday" alone is the next Friday)'],
    "diary": [r'"diary"[^.\n]{0,80}?(?:\||=|means)\s*(?:the )?calendar'],
    "wifi": [r"wifi[^\n]*`?answer rows`?", r"wifi[^\n]*show me"],
    "balance": [r"positive = they owe me", r"sign (?:comes from|is) the vault"],
}

EGRESS = re.compile(r"\b(text|whatsapp|send|email|e-mail|forward|post|paste|share|message|dm|airdrop)\b", re.I)
INVENT = re.compile(r"\b(make (?:one |it )?up|invent|come up with|generate|guess|think of)\b", re.I)
REVEAL_VERB = re.compile(r"\b(show me|show it|tell me|read (?:it |that )?(?:out|to me)|read me|reveal|give me|let me see)\b", re.I)
WIFI_ANY = re.compile(r"\bwi-?fi\b", re.I)
OWE_ME = re.compile(r"\b(owes? me|owed|owe me|owing me)\b", re.I)
I_OWE = re.compile(r"\b(do i owe|i owe|owe him|owe her|owe them|i still owe|do i still owe|what i owe|how much i owe|"
                   r"owe \w+ anything|i'm owed|am i owed)\b", re.I)
CONV_ASK = re.compile(r"am or pm|morning or (?:evening|night|afternoon)|(?:evening|pm) or (?:morning|am)|this or next|"
                      r"next or this|this week or|last week or|weekend or|weeks? start", re.I)
TRASH_NOUN = re.compile(r"\b(?:the|a|my|in|from|of|photo|photos|task|tasks|doc|docs|document|documents|locker|note|notes|"
                        r"calendar|event|events|contacts|people|album|home|group|list|and|any)\s+trash\b", re.I)
NARROW = {"when", "where", "linked_to", "within", "order", "limit", "exclude"}
ROWK = re.compile(r"#(\d+)(?: \[\d+\])? ([a-z ]+?) \"([^\"]+)\"")


def norm(s: str) -> str:
    return " ".join(s.lower().split())


def words(s: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", s.lower())


class Row:
    def __init__(self, rid, what, value, want, red, detail=None):
        self.rid, self.what, self.value, self.want, self.red, self.detail = rid, what, value, want, red, detail or []


# -- data ------------------------------------------------------------------------------------------------

def load_sessions(pattern: str) -> list[dict]:
    out = []
    for p in sorted(glob.glob(pattern)):
        for line in open(p, encoding="utf-8"):
            s = json.loads(line)
            if not split.is_val(s):
                out.append(s)
    return out


def all_turns(sessions):
    for s in sessions:
        for i, t in enumerate(s["turns"], 1):
            yield s, i, t


def good_calls(t: dict) -> list[dict]:
    return [c for c in t["ref"] if not c.get("bad")]


def has_reveal(t: dict) -> bool:
    return any(c["tool"] == "act" and c["args"].get("verb") == "reveal" for c in good_calls(t))


def world_has_diary(world: str) -> bool:
    f = HERE / "worlds" / f"{world}.json"
    return f.exists() and "diary" in f.read_text(encoding="utf-8").lower()


# -- date expressions (SPEC 4.4), just enough to resolve points the way the runtime does --------------------

def date_exprs(t: dict) -> list[dict]:
    out = []

    def walk(v):
        if isinstance(v, str) and v[:1] in "{[":
            try:
                v = json.loads(v)
            except ValueError:
                return
        if isinstance(v, dict):
            if "unit" in v or "date" in v:
                out.append(v)
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)

    for c in good_calls(t):
        a = c["args"]
        for k in ("when", "to", "from", "date", "due"):
            if k in a:
                walk(a[k])
        if isinstance(a.get("args"), str):
            for ln in a["args"].splitlines():
                k, _, v = ln.partition(": ")
                if k.strip() in ("to", "date", "due", "when", "from"):
                    walk(v.strip())
    return out


def resolve(e: dict, today: str):
    if e.get("anchor") == "row":
        return None
    d0 = datetime.date.fromisoformat(today[:10])
    if "date" in e and "unit" not in e:
        return datetime.date.fromisoformat(e["date"])
    if e.get("unit") == "day":
        return d0 + datetime.timedelta(days=e["rel"])
    if e.get("unit") == "week" and "weekday" in e:
        mon = d0 - datetime.timedelta(days=d0.weekday()) + datetime.timedelta(weeks=e["rel"])
        return mon + datetime.timedelta(days=e["weekday"] - 1)
    return None


def points(t: dict, today: str) -> list[datetime.date]:
    return [p for p in (resolve(e, today) for e in date_exprs(t)) if p]


# -- checks ------------------------------------------------------------------------------------------------

def check_stated(spec14: str, brief: str) -> list[Row]:
    rows = []
    for c in CONVENTIONS:
        missing = [f"{name}: /{pat}/" for name, doc in (("SPEC 14", spec14), ("BRIEF", brief))
                   for pat in STATED[c] if not re.search(pat, doc)]
        rows.append(Row(f"stated.{c}", "written in SPEC section 14 and BRIEF.md", "yes" if not missing else "missing", "yes", bool(missing), missing))
    return rows


def outcome_class(t: dict) -> str:
    return t["gold"][0]["type"]


def check_wifi(turns) -> Row:
    bad, n = [], Counter()
    for s, i, t in turns:
        u = t["user"]
        if not (WIFI_ANY.search(u) and (conventions.detect(t) and "wifi" in conventions.detect(t) or has_reveal(t))):
            continue
        g = outcome_class(t)
        if EGRESS.search(u) or INVENT.search(u):
            want = {"decline"}
            kind = "decline"
        elif REVEAL_VERB.search(u):
            want, kind = {"diff", "ask"}, "reveal"
        elif has_reveal(t) or any(c["tool"] == "act" for c in good_calls(t)):
            want, kind = {"rows"}, "read"      # no reveal verb: an act here is the T23-089 pattern
        else:
            want, kind = {"rows"}, "read"
        n[kind] += 1
        ok = g in want and (kind == "reveal") == has_reveal(t) if kind != "decline" else g in want
        if not ok:
            bad.append(f"{s['id']} t{i} [{g}] {u}")
    return Row("outcome.wifi", "wifi turns end in the outcome the message form gives (read / reveal / decline)",
               len(bad), 0, bool(bad), bad or [f"{k}: {v}" for k, v in sorted(n.items())])


def check_diary(turns) -> Row:
    bad, taught, worlds = [], 0, set()
    for s, i, t in turns:
        u = t["user"]
        if not re.search(r"\bdiary\b", u, re.I) or world_has_diary(s["world"]) or re.search(r"diary entr|journal", u, re.I):
            continue
        kinds = {c["args"].get("kind") for c in good_calls(t) if c["tool"] in ("answer", "find", "act")}
        if kinds & {"note", "notebook"} and "event" not in kinds:
            bad.append(f"{s['id']} t{i} {u}")
        else:   # events, or a person query / ask about the calendar: the note reading is absent either way
            taught += 1
            worlds.add(s["world"])
    detail = bad or [f"{taught} calendar-diary turns in {len(worlds)} worlds"]
    red = bool(bad) or taught < 24 or len(worlds) < 8
    return Row("outcome.diary", "diary reads as the calendar (no note reading; >= 24 turns in >= 8 worlds)",
               f"{len(bad)} misread, {taught} taught/{len(worlds)}w", "0 misread, >=24/>=8w", red, detail)


def check_balance(turns) -> Row:
    bad, n = [], 0
    for s, i, t in turns:
        calls = [c for c in good_calls(t) if c["tool"] in ("answer", "compute") and c["args"].get("op") == "balance"]
        if not calls:
            continue
        n += 1
        if outcome_class(t) != "value":
            bad.append(f"{s['id']} t{i} [{outcome_class(t)}] {t['user']}")
            continue
        if any(c["tool"] == "act" for c in good_calls(t)):
            continue
        amounts = [v["amount"] for g in t["gold"] for v in g.get("values", []) if isinstance(v.get("amount"), (int, float))]
        amounts += [v["amount"] for g in t["gold"] for vs in g.get("groups", {}).values() for v in vs
                    if isinstance(v.get("amount"), (int, float))]
        amounts = [a for a in amounts if a]
        u = t["user"]
        if not amounts:
            continue
        if OWE_ME.search(u) and not I_OWE.search(u) and max(amounts) < 0:
            bad.append(f"{s['id']} t{i} says they owe me, vault says I owe {amounts}: {u}")
        if I_OWE.search(u) and not OWE_ME.search(u) and min(amounts) > 0:
            bad.append(f"{s['id']} t{i} says i owe, vault says they owe me {amounts}: {u}")
    return Row("outcome.balance", "balance turns end in a value whose sign the wording does not contradict",
               len(bad), 0, bool(bad), bad or [f"{n} balance turns"])


def check_dates(turns) -> dict[str, Row]:
    viol: dict[str, list[str]] = {c: [] for c in ("next_weekday", "weekend", "week", "at_n", "last_month_name", "bare_weekday")}
    seen: dict[str, Counter] = {c: Counter() for c in viol}
    nxt = re.compile(r"\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b", re.I)
    bare = re.compile(r"\b(?:to|for|on|till|until)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b"
                      r"(?!\s*(?:the|\d|,?\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)))", re.I)
    for s, i, t in turns:
        u, tag = t["user"], f"{s['id']} t{i}"
        fired = conventions.detect(t)
        for c in viol:
            if c in fired:
                seen[c][outcome_class(t)] += 1
        for c in fired:
            if c in viol and outcome_class(t) == "ask":
                for call in good_calls(t):
                    if call["tool"] == "ask" and CONV_ASK.search(call["args"].get("question", "") + " " + str(call["args"].get("options", ""))):
                        viol[c].append(f"{tag} asks what the rule decides: {u}")
        pts = points(t, s["today"])
        d0 = datetime.date.fromisoformat(s["today"][:10])
        m = nxt.findall(u)
        if len(m) == 1 and pts:
            mon = d0 - datetime.timedelta(days=d0.weekday()) + datetime.timedelta(weeks=1)
            want = mon + datetime.timedelta(days=WEEKDAYS[m[0].lower()] - 1)
            # a bare week expression starts on its Monday ("from next monday" = {"unit":"week","rel":1})
            pts = pts + [resolve({**e, "weekday": 1}, s["today"]) for e in date_exprs(t) if e.get("unit") == "week" and "weekday" not in e]
            if want not in pts and not any(e.get("anchor") == "row" for e in date_exprs(t)):
                viol["next_weekday"].append(f"{tag} today {s['today'][:10]}: {u} -> {want} not in {[str(p) for p in pts]}")
        if "weekend" in u.lower() and len(re.findall("weekend", u.lower())) == 1:
            rel = 1 if re.search(r"next weekend", u.lower()) else 0 if re.search(r"(?:this|the|coming) weekend", u.lower()) else None
            rels = [e["rel"] for e in date_exprs(t) if e.get("unit") == "week" and e.get("weekday") in (6, 7)]
            if rel is not None and rels and any(r != rel for r in rels):
                viol["weekend"].append(f"{tag} today {s['today'][:10]}: {u} -> rel {rels}, rule says {rel}")
        wk = re.findall(r"\b(this|next|last) week\b", u.lower())
        if len(wk) == 1 and "weekend" not in u.lower() and not re.search(r"\bbefore this week\b", u.lower()):
            rel = {"this": 0, "next": 1, "last": -1}[wk[0]]
            rels = [e["rel"] for e in date_exprs(t) if e.get("unit") == "week" and "weekday" not in e]
            if rels and rel not in rels:
                viol["week"].append(f"{tag} today {s['today'][:10]}: {u} -> rel {rels}, rule says {rel}")
        b = bare.findall(u)
        if (len(b) == 1 and not re.search(r"\b(last|next|this|past|previous|every|from|through|between|week|fortnight)\b", u, re.I)
                and not any(c["tool"] in ("answer", "find") for c in good_calls(t))):
            acts = [c for c in good_calls(t) if c["tool"] == "act" and c["args"].get("verb") in ("reschedule", "create")]
            one = [p for p in points({"ref": acts}, s["today"])] if len(acts) == 1 else []
            if len(one) == 1 and not any(e.get("anchor") == "row" for e in date_exprs({"ref": acts})):
                want = d0 + datetime.timedelta(days=(WEEKDAYS[b[0].lower()] - 1 - d0.weekday()) % 7)
                if one[0] != want:
                    viol["bare_weekday"].append(f"{tag} today {s['today'][:10]} ({d0:%a}): {u} -> {one[0]}, rule says {want}")
    out = {}
    for c, v in viol.items():
        mix = ", ".join(f"{k} {n}" for k, n in sorted(seen[c].items()))
        out[c] = Row(f"outcome.{c}", "no ask decides what the rule decides; the date the call uses is the rule's",
                     len(v), 0, bool(v), v or [f"outcomes: {mix}"])
    return out


def kind_steps(pattern: str):
    """By-name writes in the built records with the rows of their kind that fit the name, as the context shows."""
    for p in sorted(glob.glob(pattern)):
        for line in gzip.open(p, "rt", encoding="utf-8"):
            r = json.loads(line)
            if split.is_val(r["id"]):
                continue
            ms = r["messages"]
            for i, m in enumerate(ms):
                if m["role"] != "assistant" or m["tool"] != "act":
                    continue
                a = m["args"]
                if not a.get("name") or a.get("rows"):
                    continue
                rows = {}
                for x in ms[:i]:
                    if x["role"] in ("user", "tool"):
                        for n, k, nm in ROWK.findall(x["content"]):
                            rows[int(n)] = (k, nm)
                want = set(words(str(a["name"])))
                fits = [(n, nm) for n, (k, nm) in rows.items() if want <= set(words(nm)) and (not a.get("kind") or k == a["kind"])]
                nxt = ms[i + 1]["content"] if i + 1 < len(ms) and ms[i + 1]["role"] == "tool" else ""
                u = max((j for j in range(i) if ms[j]["role"] == "user"), default=None)
                yield {"sid": r["id"], "args": a, "fits": fits, "res": nxt,
                       "user": ms[u]["content"].rpartition("\n\n")[2] if u is not None else "", "think": m.get("think", "")}


SEG_SAW = re.compile(r"saw: ([^·]*?)(?: ·|$)")


def check_ambiguity(records_glob: str, sessions: list[dict]) -> list[Row]:
    steps = list(kind_steps(records_glob))
    if not steps:
        return [Row("ambiguity.went_ahead", "records not found", "n/a", 0, True, [records_glob])]
    went, flow, narrowed, single = [], 0, 0, 0
    proxy = 0
    for st in steps:
        multi = len(st["fits"]) >= 2
        bounced = st["res"].startswith("ambiguous")
        narrow = bool(NARROW & set(st["args"]))
        if multi and bounced:
            flow += 1
        elif multi and narrow:
            narrowed += 1
        elif multi:
            went.append(f"{st['sid']}: {st['user']} -> {st['args'].get('verb')} {st['args'].get('name')!r} fits {st['fits'][:3]}: {st['res'][:70]}")
        else:
            single += 1
        # the gapreport tile (build.py `saw:` list, names only, every kind)
        want = set(words(str(st["args"]["name"])))
        seg = SEG_SAW.search(st["think"])
        fits = [nm for nm in re.findall(r"#\d+ ([^#]*?)(?:, (?=#)| \+\d+$|$)", seg.group(1)) if want <= set(words(nm))] if seg else []
        proxy += len(fits) >= 2
    n = len(steps)
    turns = sum(len(s["turns"]) for s in sessions)
    amb = sum(bool(t.get("ambiguous")) for s in sessions for t in s.get("replay", []))
    share = amb / max(1, turns)
    info = [f"by-name writes {n}: runtime answered ambiguous after {flow} (act, then ask or pick: the runtime is the safety check, SPEC 3.3), "
            f"{narrowed} multi-fit but narrowed by when/where/linked_to/exclude, {len(went)} accepted with two same-kind rows fitting and nothing narrowing, "
            f"{single} single fit",
            f"gapreport tile (names only, every kind, replies included): {proxy}/{n} = {100 * proxy / n:.1f}%"]
    return [
        Row("ambiguity.went_ahead", "by-name writes accepted although 2+ same-kind rows fit and nothing narrows them",
            len(went), 0, bool(went), went or info),
        Row("ambiguity.turn_share", "turns where the runtime answered ambiguous (GOALS 3: 3 to 7%)",
            f"{100 * share:.1f}%", "3-7%", not 0.03 <= share <= 0.07, info),
    ]


def check_vocabulary(turns, gapbrief: str, brief: str) -> list[Row]:
    bad = []
    for s, i, t in turns:
        u = t["user"]
        stripped = TRASH_NOUN.sub(" ", u)
        if re.search(r"\b(trash|binned)\b", stripped, re.I):
            bad.append(f"{s['id']} t{i} {u}")
    docs = [n for n, txt in (("BRIEF", brief), ("GAPBRIEF", gapbrief)) if re.search(r'"trash (?:all|every|everything)', txt) and 'never "trash' not in txt]
    says = bool(re.search(r'never "trash all', brief)) and "delete" in brief
    return [
        Row("vocabulary.trash_verb", "user messages using trash/bin as an action (users say delete)", len(bad), 0, bool(bad), bad),
        Row("vocabulary.briefs", "BRIEF.md says delete for the action; no brief tells authors to write 'trash all of them'",
            "ok" if says and not docs else "conflict", "ok", not (says and not docs), docs or ([] if says else ["BRIEF lacks the rule"])),
    ]


def check_hygiene(turns, near: bool) -> list[Row]:
    val = {}
    for line in open(NATIVE / "eval" / "sets" / "val.jsonl", encoding="utf-8"):
        for t in json.loads(line)["turns"]:
            val[norm(t["user"])] = t["user"].strip()
    bad = [f"{s['id']} t{i} {t['user']}" for s, i, t in turns if norm(t["user"]) in val and len(t["user"].split()) >= 6]
    rows = [Row("hygiene.exact_dup_val", "train messages (6+ words) identical to a val message", len(bad), 0, bool(bad), bad)]
    if near:
        import numpy as np
        import gate
        tr = [(s["id"], i, t["user"].strip()) for s, i, t in turns if len(t["user"].split()) >= 6]
        vv = list(val.values())
        sims = gate.embed([x[2] for x in tr]) @ gate.embed(vv).T
        hits = {}
        for i, j in zip(*np.where(sims >= gate.DUP_COS)):
            hits.setdefault(i, (float(sims[i, j]), vv[j]))
        top = [f"{sim:.3f} {tr[i][0]} t{tr[i][1]} {tr[i][2]!r} ~ {v!r}" for i, (sim, v) in sorted(hits.items(), key=lambda x: -x[1][0])[:25]]
        rows.append(Row("hygiene.near_dup_val", "train messages (6+ words) at cos >= 0.95 to a val message (info)", len(hits), "info", False, top))
    else:
        rows.append(Row("hygiene.near_dup_val", "near-duplicates of val messages (run with --near)", "not run", "info", False))
    return rows


# -- main --------------------------------------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gold", default="/tmp/authored-T[0-9][0-9]/T[0-9][0-9].gold.jsonl")
    ap.add_argument("--records", default="/tmp/authored-T[0-9][0-9]/T[0-9][0-9].jsonl.gz")
    ap.add_argument("--near", action="store_true")
    ap.add_argument("--spec", default=str(NATIVE / "SPEC.md"))
    ap.add_argument("--brief", default=str(HERE / "BRIEF.md"))
    ap.add_argument("--gapbrief", default=str(HERE / "GAPBRIEF.md"))
    ap.add_argument("--json")
    ap.add_argument("-v", "--verbose", action="store_true", help="list the offending turns of every row")
    a = ap.parse_args()

    sessions = load_sessions(a.gold)
    turns = list(all_turns(sessions))
    spec = Path(a.spec).read_text(encoding="utf-8")
    spec14 = spec[spec.index("## 14. Decisions"):]
    brief = Path(a.brief).read_text(encoding="utf-8")
    gapbrief = Path(a.gapbrief).read_text(encoding="utf-8")

    rows = check_stated(spec14, brief)
    dates = check_dates(turns)
    outcome = {"wifi": check_wifi(turns), "diary": check_diary(turns), "balance": check_balance(turns), **dates}
    rows += [outcome[c] for c in CONVENTIONS]
    rows += check_ambiguity(a.records, sessions)
    rows += check_vocabulary(turns, gapbrief, brief)
    rows += check_hygiene(turns, a.near)

    print(f"train sessions {len(sessions)}, turns {len(turns)}")
    print(f"{'row':28} {'value':26} {'want':10} status  what")
    for r in rows:
        print(f"{r.rid:28} {str(r.value):26} {str(r.want):10} {'RED' if r.red else 'ok':6}  {r.what}")
        if r.red or a.verbose:
            for d in r.detail[:40]:
                print(f"      {d}")
    red = sum(r.red for r in rows)
    print(f"\nred rows: {red} of {len(rows)}")
    if a.json:
        json.dump([{"row": r.rid, "value": r.value, "want": r.want, "red": r.red, "detail": r.detail} for r in rows],
                  open(a.json, "w"), indent=1, ensure_ascii=False, default=str)
    sys.exit(1 if red else 0)


if __name__ == "__main__":
    main()
