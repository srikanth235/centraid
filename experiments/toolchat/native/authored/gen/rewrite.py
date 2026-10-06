"""The reference rewriter: point every reference at what the prompt already shows (phase 5, #1044).

    python3 authored/gen/rewrite.py --out DIR [--dry] [--verify [T01,T10]] [--worlds train | T01,T02]
                                    [--sessions-dir DIR] [--worlds-dir DIR [--base-worlds-dir DIR]] [--jobs 4]

Replays every session of the worlds with its reference calls (the eval driver's `RefBackend`), then, turn by turn, reads
the user message's block the way the model does: the `vault:` line (rows the message names), the `focus:` line (the
rows of the last result) and the `dates:` line (the dates and times its words mean). A reference call whose target the
prompt shows is rewritten, in a COPY of the session source, to point at it:

  name_block / name_focus   a call that names ONE kind and ONE name (no filter, no other selector) and acts on rows
                            that the vault (focus) line shows: `kind`+`name` become `rows="$key"` (`#n` at replay);
  handle_focus              `rows="@prev"` (or `@n`) as the first call of a turn, on rows the focus line shows;
  when_dates                a `when` expression that resolves to a date, a time of a date or a closed span the dates
                            line gives becomes that value (`{"date": ...}`, `{"from": {...}, "to": {...}}`);
  args_dates                the same for the date of a `to:`, `date:`, `start:` or `due:` line of `args`.

A reference with no anchor in the prompt stays: the counts list them by reason (`no_anchor`). `bad` calls, creates,
undos and calls that end in an ambiguity or a refusal are not touched. A rewritten call is written `C(...)` source;
every other byte of the file is kept.

  --dry      replay and count; write nothing.
  --out DIR  write the copy (`<W>.py`, `<W>_*.py` of the chosen worlds) and DIR/rewrite.report.json.
  --verify   build the sessions of the given worlds (default T01,T10) with authored/build.py --gold-from-ref from the
             original and from the copy, and compare: sessions verified, and the regenerated gold of every turn; any
             difference is listed (the effect of a rewritten reference changed).
  --worlds-dir DIR  replay on collision worlds (collide.py): the rewrites above, and a pick: where a name that the base
             world (`--base-worlds-dir`, default authored/worlds) resolves to one row now fits several (`ambiguous:`),
             the call is rewritten to the row the base world resolved when the conversation decides (the focus line
             shows it and none of the others) or the message names what tells it from the others (a word only its
             name has); otherwise the session is reported as dropped (`pick_dropped`: nothing decides, the right
             answer is an ask the session does not make).

NATIVETOOLS and EVAL_VAULTS as for authored/build.py. Deterministic: no draws.
"""
from __future__ import annotations

import argparse
import collections
import concurrent.futures as cf
import datetime
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402
from common import AUTHORED, Edit, render_call  # noqa: E402

REWRITE_VERBS = {"edit", "reschedule", "complete", "reopen", "cancel", "delete", "restore", "star", "unstar", "settle_debt",
                 "reveal", "log"}
NAME_KEYS = {"verb", "args", "more", "op", "field", "kind", "name", "value"}
DATE_LINES = ("to", "date", "start", "due")
WEEKDAY = {1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6}


# --- reading the block ---------------------------------------------------------------------------------------------


def block_lines(block: str | None) -> dict[str, str]:
    out = {}
    for ln in (block or "").split("\n"):
        for tag in ("vault", "focus", "dates"):
            if ln.startswith(tag + ":"):
                out[tag] = ln[len(tag) + 1:].strip()
    return out


def ns_of(line: str) -> list[int]:
    return [int(n) for n in re.findall(r"#(\d+)", line or "")]


def parse_dates(line: str) -> list[dict]:
    """The entries of a dates line: {date}, {from, to}, {time}, with the past/upcoming pair as two entries."""
    out = []
    for part in (line or "").split(" · "):
        _k, _, v = part.partition(" = ")
        for alt in v.split(" / "):
            alt = re.sub(r"\s*\((past|upcoming)\)$", "", alt.strip())
            if re.fullmatch(r"\d{4}-\d\d-\d\d", alt):
                out.append({"date": alt})
            elif re.fullmatch(r"\d{4}-\d\d-\d\d\.\.\d{4}-\d\d-\d\d", alt):
                a, b = alt.split("..")
                out.append({"from": a, "to": b})
            elif re.fullmatch(r"\d\d:\d\d", alt):
                out.append({"time": alt})
    return out


def add_months(day: datetime.date, n: int) -> datetime.date:
    m = day.month - 1 + n
    return datetime.date(day.year + m // 12, m % 12 + 1, 1)


def resolve(expr, today: datetime.date) -> dict | None:
    """A date expression as {date[, time]} or {from, to} (dates), None when the form is not handled."""
    if not isinstance(expr, dict):
        return None
    if "date" in expr and len(set(expr) - {"date", "time"}) == 0:
        return {"date": expr["date"], **({"time": expr["time"]} if "time" in expr else {})}
    unit, rel = expr.get("unit"), expr.get("rel")
    if not isinstance(rel, int) or set(expr) - {"unit", "rel", "weekday", "time"}:
        return None
    t = {"time": expr["time"]} if "time" in expr else {}
    if unit == "day" and "weekday" not in expr:
        return {"date": str(today + datetime.timedelta(days=rel)), **t}
    if unit == "week":
        monday = today - datetime.timedelta(days=today.weekday()) + datetime.timedelta(weeks=rel)
        if "weekday" in expr:
            if not isinstance(expr["weekday"], int) or expr["weekday"] not in WEEKDAY:
                return None
            return {"date": str(monday + datetime.timedelta(days=WEEKDAY[expr["weekday"]])), **t}
        return {"from": str(monday), "to": str(monday + datetime.timedelta(days=6))} if not t else None
    if unit == "month" and not t and "weekday" not in expr:
        first = add_months(today, rel)
        return {"from": str(first), "to": str(add_months(first, 1) - datetime.timedelta(days=1))}
    if unit == "year" and not t and "weekday" not in expr:
        y = today.year + rel
        return {"from": f"{y}-01-01", "to": f"{y}-12-31"}
    return None


def anchor_date(expr: dict, entries: list[dict], today: datetime.date) -> dict | None:
    """The replacement for a date expression the dates line gives, else None. An open or closed span `{from, to}` is
    anchored end by end (every end it has must be)."""
    if isinstance(expr, dict) and expr and set(expr) <= {"from", "to"}:
        parts = {k: anchor_date(v, entries, today) for k, v in expr.items()}
        if any(p is None or "from" in p for p in parts.values()):
            return None
        return parts
    r = resolve(expr, today)
    if r is None:
        return None
    if "from" in r:
        hit = any(e.get("from") == r["from"] and e.get("to") == r["to"] for e in entries)
        return {"from": {"date": r["from"]}, "to": {"date": r["to"]}} if hit else None
    if not any(e.get("date") == r["date"] for e in entries):
        return None
    if "time" in r and not any(e.get("time") == r["time"] for e in entries):
        return None
    return {"date": r["date"], **({"time": r["time"]} if "time" in r else {})}


def dump(obj) -> str:
    return json.dumps(obj, separators=(",", ":"))


# --- analysis of one session -----------------------------------------------------------------------------------------


def target_rows(eff: dict) -> list[dict] | None:
    """The rows a reference call acted on or answered with; None when the call ended in an ambiguity or composed
    outcome or has no rows."""
    import lib

    if not eff or eff.get("ambiguous") or eff.get("composed") or eff.get("error"):
        return None
    rows = [r for r in lib.effect_rows({k: v for k, v in eff.items() if k not in ("created", "already", "ask")})
            if r.get("kind") is not None or "id" in r]
    seen, out = set(), []
    for r in rows:
        if r["n"] not in seen:
            seen.add(r["n"])
            out.append(r)
    return out or None


def analyse(sess: dict, rec: dict, key_of: dict[str, str]) -> tuple[list[tuple[int, int, dict, str]], collections.Counter]:
    """[(turn, step, new call, kind)] and the counts of references left as they are, by reason."""
    today = datetime.date.fromisoformat(sess["today"][:10])
    out, none = [], collections.Counter()
    for ti, t in enumerate(sess["turns"]):
        if ti >= len(rec["turns"]):
            break
        lines = block_lines(rec["turns"][ti]["preground"])
        vault_ns, focus_ns = set(ns_of(lines.get("vault", ""))), set(ns_of(lines.get("focus", "")))
        entries = parse_dates(lines.get("dates", ""))
        steps = rec["turns"][ti]["steps"]
        for k, c in enumerate(t["ref"]):
            if k >= len(steps) or c.get("bad"):
                continue
            a = dict(c.get("args", {}))
            new = {"tool": c["tool"], "args": dict(a)}
            kind = None
            # dates first: they leave the selector as it is
            if c["tool"] in ("answer", "act", "compute", "find") and a.get("when") and isinstance(a["when"], (str, dict)):
                try:
                    expr = json.loads(a["when"]) if isinstance(a["when"], str) else a["when"]
                except ValueError:
                    expr = None
                rep = anchor_date(expr, entries, today) if expr is not None else None
                if rep is not None and rep != expr:
                    new["args"]["when"] = dump(rep) if isinstance(a["when"], str) else rep
                    kind = "when_dates"
                elif rep is None:
                    none["when: no dates-line entry" if entries else "when: no dates line"] += 1
            if c["tool"] == "act" and a.get("verb") in ("reschedule", "edit", "create") and isinstance(a.get("args"), str):
                lns = a["args"].split("\n")
                for i, ln in enumerate(lns):
                    f, _, v = ln.partition(":")
                    if f.strip() in DATE_LINES and v.strip().startswith("{"):
                        try:
                            expr = json.loads(v.strip())
                        except ValueError:
                            continue
                        rep = anchor_date(expr, entries, today)
                        if rep is not None and "from" not in rep and rep != expr:
                            lns[i] = f"{f.strip()}: {dump(rep)}"
                            new["args"]["args"] = "\n".join(lns)
                            kind = kind or "args_dates"
                        elif rep is None:
                            none["args date: no dates-line entry" if entries else "args date: no dates line"] += 1
            # then the rows
            rows_arg = a.get("rows", "") if isinstance(a.get("rows", ""), str) else ""
            is_name = c["tool"] in ("answer", "act", "compute") and "kind" in a and isinstance(a.get("name"), str) \
                and "$" not in a["name"] \
                and not (set(a) - NAME_KEYS) and (c["tool"] != "act" or a.get("verb") in REWRITE_VERBS) \
                and a.get("verb") not in ("create", "undo")
            is_handle = c["tool"] in ("answer", "act", "compute") and re.fullmatch(r"@(prev|\d+)", rows_arg or "") and k == 0 \
                and (c["tool"] != "act" or a.get("verb") in REWRITE_VERBS)
            if is_name or is_handle:
                rows = target_rows(steps[k]["response"].get("effect") or {})
                ns = {r["n"] for r in rows or []}
                keys = [key_of.get(r["id"]) for r in rows or []]
                if not rows:
                    none["rows: call ended without target rows"] += 1
                elif None in keys:
                    none["rows: a target row has no key"] += 1
                elif not {r["id"] for r in rows} <= rec["known"].get((ti, k), set()):
                    none["rows: a target row cannot be named by key there"] += 1
                elif is_name and ns <= vault_ns | focus_ns:
                    rk = "name_block" if ns <= vault_ns else ("name_focus" if ns <= focus_ns else "name_block")
                    new["args"] = {kk: vv for kk, vv in new["args"].items() if kk not in ("kind", "name")}
                    new["args"]["rows"] = ", ".join(f"${x}" for x in keys)
                    kind = rk if kind is None else kind + "+" + rk
                elif is_handle and ns <= focus_ns:
                    new["args"]["rows"] = ", ".join(f"${x}" for x in keys)
                    kind = "handle_focus" if kind is None else kind + "+handle_focus"
                else:
                    none["rows: target not shown in the block or focus line"] += 1
            if kind:
                out.append((ti, k, new, kind))
    return out, none


def decides(message: str, intended: list[str], others: list[str]) -> bool:
    """The message names what tells the intended row from the others: one whole word of the intended name that no other
    candidate's name has. (The focus line can decide too: see `analyse_pick`.)"""
    msg = set(re.findall(r"[a-z]{3,}", message.lower()))
    other_words = {w for o in others for w in re.findall(r"[a-z]{3,}", o.lower())}
    for name in intended:
        if any(w in msg and w not in other_words for w in re.findall(r"[a-z]{3,}", name.lower())):
            return True
    return False


def analyse_pick(sess: dict, rec_c: dict, rec_b: dict, key_c: dict, key_b: dict, names_c: dict) -> tuple[list, list]:
    """Collision worlds: [(turn, step, new call)] for calls that became ambiguous and that the message decides, and
    [(turn, step)] for the ones it does not."""
    import lib

    picks, dropped = [], []
    for ti, t in enumerate(sess["turns"]):
        if ti >= len(rec_c["turns"]) or ti >= len(rec_b["turns"]):
            break
        for k, c in enumerate(t["ref"]):
            if k >= len(rec_c["turns"][ti]["steps"]) or k >= len(rec_b["turns"][ti]["steps"]) or c.get("bad"):
                continue
            ec = rec_c["turns"][ti]["steps"][k]["response"].get("effect") or {}
            if not ec.get("ambiguous"):
                continue
            base = target_rows(rec_b["turns"][ti]["steps"][k]["response"].get("effect") or {})
            if not base:
                continue
            want = [key_b.get(r["id"]) for r in base]
            cand = [key_c.get(r["id"]) for r in lib.effect_rows({"ambiguous": ec["ambiguous"]})]
            if None in want or not set(want) <= set(cand):
                dropped.append((ti, k))
                continue
            others = [names_c.get(x, "") for x in cand if x not in want]
            n_of_key = {key_c.get(r["id"]): r["n"] for r in lib.effect_rows({"ambiguous": ec["ambiguous"]})}
            focus = set(ns_of(block_lines(rec_c["turns"][ti]["preground"]).get("focus", "")))
            by_focus = {n_of_key[x] for x in want} <= focus and not any(n_of_key[x] in focus for x in cand if x not in want)
            if by_focus or decides(t["user"], [names_c.get(x, "") for x in want], others):
                new = {"tool": c["tool"], "args": {kk: vv for kk, vv in c["args"].items()
                                                  if kk not in ("kind", "name", "where", "linked_to")}}
                new["args"]["rows"] = ", ".join(f"${x}" for x in want)
                picks.append((ti, k, new))
            else:
                dropped.append((ti, k))
    return picks, dropped


# --- driving ---------------------------------------------------------------------------------------------------------


def replay(sess: dict) -> dict:
    """The reference run of a session; `rec["known"][(turn, step)]` is the set of row ids a `$key` can name there."""
    import run

    class Spy(run.RefBackend):
        def __init__(self):
            self.known: dict = {}

        def step(self, transcript, ctx):
            self.known[(ctx["turn"], ctx["step"])] = set(ctx["n_of"])
            return super().step(transcript, ctx)

    s = {k: v for k, v in sess.items() if k != "_site"}
    spy = Spy()
    rec = run.run_session(s, spy)
    rec["known"] = spy.known
    return rec


def key_map(w: str, worlds_dir: Path) -> dict[str, str]:
    return {v["id"]: k for k, v in json.loads((worlds_dir / f"{w}.keys.json").read_text()).items()}


def work(w: str, sessions_dir: str, worlds_dir: str | None, base_dir: str | None) -> dict:
    """Analyse every session of one world (a child process)."""
    import build
    import lib

    sdir = Path(sessions_dir)
    wdir = Path(worlds_dir) if worlds_dir else AUTHORED / "worlds"
    bdir = Path(base_dir) if base_dir else AUTHORED / "worlds"
    out = {"edits": [], "counts": collections.Counter(), "none": collections.Counter(), "touched": set(),
           "pick_dropped": []}
    sessions = common.load_sessions(w, sdir)
    usable = common.usable_sites(w, sessions, sdir)
    names_c = {}
    if worlds_dir:
        world = json.loads((wdir / f"{w}.json").read_text())
        names_c = {r["key"]: r["name"] for sec in world.values() if isinstance(sec, list) for r in sec
                   if isinstance(r, dict) and "key" in r and "name" in r}
        recs_b = {}
        lib.WORLDS = bdir
        build.seed(w, bdir)
        for s in sessions:
            try:
                recs_b[s["id"]] = replay(s)
            except Exception as e:  # noqa: BLE001
                recs_b[s["id"]] = None
        lib.WORLDS = wdir
    else:
        recs_b = {}
    build.seed(w, wdir)
    key_c = key_map(w, wdir)
    key_b = key_map(w, bdir) if worlds_dir else key_c
    for s in sessions:
        try:
            rec = replay(s)
        except Exception as e:  # noqa: BLE001
            out["counts"]["replay failed"] += 1
            continue
        if worlds_dir:
            if recs_b.get(s["id"]) is None:
                continue
            picks, dropped = analyse_pick(s, rec, recs_b[s["id"]], key_c, key_b, names_c)
            if dropped:
                out["pick_dropped"].append(s["id"])
                continue
            found, none = analyse(s, rec, key_c)
            found += [(ti, k, new, "pick") for ti, k, new in picks]
        else:
            found, none = analyse(s, rec, key_c)
        out["none"].update(none)
        for ti, k, new, kind in found:
            site = s["turns"][ti]["_site"]
            if site[0] not in usable or usable[site[0]][site[1]] is None:
                out["counts"]["no source site"] += 1
                continue
            out["edits"].append(Edit(site[0], site[1], k, render_call(new), replace=True))
            out["counts"][kind] += 1
            out["touched"].add(s["id"])
    out["touched"] = sorted(out["touched"])
    return out


def compare(base: Path, new: Path, worlds: list[str]) -> dict:
    """Per world: sessions verified in both builds, and the turns whose regenerated gold differs."""
    res = {}
    for w in worlds:
        rb, rn = common.read_report(base, w), common.read_report(new, w)
        gb = {json.loads(l)["id"]: json.loads(l) for l in (base / f"{w}.gold.jsonl").read_text().splitlines()}
        gn = {json.loads(l)["id"]: json.loads(l) for l in (new / f"{w}.gold.jsonl").read_text().splitlines()}
        diff_gold, lost, fixed = [], [], []
        for sid, e in rb.items():
            if not e["pass"] and rn.get(sid, {"pass": False})["pass"]:
                fixed.append(sid)
            if e["pass"] and not rn.get(sid, {"pass": False})["pass"]:
                lost.append(sid)
            elif e["pass"] and [t["gold"] for t in gb[sid]["turns"]] != [t["gold"] for t in gn[sid]["turns"]]:
                diff_gold.append(sid)
        res[w] = {"sessions": len(rb), "verified_base": sum(e["pass"] for e in rb.values()),
                  "verified_new": sum(e["pass"] for e in rn.values()), "lost": lost, "fixed": fixed,
                  "gold_differs": diff_gold}
    return res


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path)
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--verify", nargs="?", const="T01,T10")
    ap.add_argument("--worlds", default="train")
    ap.add_argument("--sessions-dir", type=Path, default=AUTHORED / "sessions")
    ap.add_argument("--worlds-dir", type=Path)
    ap.add_argument("--base-worlds-dir", type=Path)
    ap.add_argument("--jobs", type=int, default=4)
    a = ap.parse_args()
    worlds = common.TRAIN_WORLDS if a.worlds == "train" else a.worlds.split(",")
    with cf.ProcessPoolExecutor(a.jobs) as ex:
        futs = {w: ex.submit(work, w, str(a.sessions_dir), str(a.worlds_dir) if a.worlds_dir else None,
                             str(a.base_worlds_dir) if a.base_worlds_dir else None) for w in worlds}
        res = {w: f.result() for w, f in futs.items()}
    counts, none = collections.Counter(), collections.Counter()
    edits: list[Edit] = []
    for w in worlds:
        counts.update(res[w]["counts"])
        none.update(res[w]["none"])
        edits += res[w]["edits"]
    touched = sorted({s for w in worlds for s in res[w]["touched"]})
    print("rewrites by kind:", dict(counts), "total", sum(v for k, v in counts.items() if k not in ("no source site", "replay failed")))
    print("sessions touched:", len(touched))
    print("references left (no anchor), by reason:", dict(none))
    dropped = [s for w in worlds for s in res[w]["pick_dropped"]]
    if a.worlds_dir:
        print("pick: rewritten calls", counts["pick"], " sessions dropped (the message does not decide):", len(dropped))
    if a.dry or not a.out:
        return
    common.apply_edits(a.sessions_dir, a.out, worlds, edits)
    report = {"rewrites": dict(counts), "sessions_touched": len(touched), "no_anchor": dict(none),
              "pick_dropped": dropped}
    if a.verify:
        vw = a.verify.split(",")
        env_wd = {"worlds_dir": a.worlds_dir}
        base, new = a.out / "_verify-base", a.out / "_verify-new"
        common.build_many([(w, None) for w in vw], a.sessions_dir, base, a.worlds_dir, a.jobs)
        common.build_many([(w, None) for w in vw], a.out, new, a.worlds_dir, a.jobs)
        report["verify"] = compare(base, new, vw)
        for w, r in report["verify"].items():
            print(f"{w}: sessions {r['sessions']}, verified {r['verified_base']} -> {r['verified_new']}, lost {len(r['lost'])}, "
                  f"fixed {len(r['fixed'])}, gold differs {len(r['gold_differs'])}")
    (a.out / "rewrite.report.json").write_text(json.dumps(report, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
