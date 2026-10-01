"""The P1 gates for the forward slot trace (authored/trace.py, CONTRACT_V2 §2), measured on built records.

    HF_HUB_OFFLINE=1 $PY authored/trace_check.py OUT_DIR [OUT_DIR ...] [--worlds T01,T02] [--val] [--json FILE]

OUT_DIR holds what `authored/build.py` wrote (`<W>.jsonl.gz`, the old-format records; the traces are
rebuilt from the messages in them, so no replay is needed). With `--val` the val worlds of split.json are
reported as numbers too (a replay check only: nothing here was tuned on them, and their sessions are not
listed). It reports

  (a) trace-call consistency: every call's trace is parsed back from its text and the slots are
      compared with the call (intent against the tool, verb, scope against the rows named, refer
      against the rows, pick against the rows, `when` present iff a date is carried, every quote a
      span of the user's words); the text must also survive parse -> render unchanged;
  (b) call arguments with no slot source: every value a call carries must trace to a quoted span of
      the message, a closed word, a number the message states, a handle the context shows, or text
      the conversation already holds; counted over the converted sessions' own calls (a call marked
      bad is a deliberate mistake and is not held to it), and raw over every call before conversion;
  (c) the share of sessions converted automatically, and every other session by id with its reason;
  (d) train tokens, old trace against new, over the converted sessions' records (whole record and the
      think text alone).
"""
from __future__ import annotations

import argparse
import collections
import gzip
import importlib.util
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
NATIVE = HERE.parent
sys.path[:0] = [str(NATIVE)]


def load_trace():
    spec = importlib.util.spec_from_file_location("authored_trace", HERE / "trace.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["authored_trace"] = mod
    spec.loader.exec_module(mod)
    return mod


T = load_trace()


def records(dirs: list[str], worlds: list[str]):
    for d in dirs:
        for w in worlds:
            f = Path(d) / f"{w}.jsonl.gz"
            if not f.exists():
                continue
            with gzip.open(f, "rt") as fh:
                for line in fh:
                    yield json.loads(line)


def convert(rec: dict):
    """-> (traces by message index, None) or (None, (reason, detail, message index))."""
    msgs = rec["messages"]
    out = {}
    prev_bad = False
    for i, m in enumerate(msgs):
        if m["role"] == "user":
            prev_bad = False
        if m["role"] != "assistant":
            continue
        bad = m.get("loss") is False
        try:
            out[i] = T.derive_trace({"tool": m["tool"], "args": m["args"]}, msgs[:i], None, prev_bad, msgs[i + 1:], bad=bad)
        except T.TraceError as e:
            return None, (e.reason, e.detail, i)
        prev_bad = bad
    return out, None


def tokenizer():
    try:
        import render

        return render, render.tokenizer()
    except Exception as e:  # noqa: BLE001
        print(f"(token counts skipped: {e})", file=sys.stderr)
        return None, None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("dirs", nargs="+")
    ap.add_argument("--worlds", help="comma list (default: the train worlds of split.json)")
    ap.add_argument("--val", action="store_true", help="also report the val worlds (numbers only)")
    ap.add_argument("--no-tokens", action="store_true")
    ap.add_argument("--json")
    ap.add_argument("--list", help="write the train sessions left unconverted (id, reason, value) to this tsv")
    a = ap.parse_args()
    split = json.loads((HERE / "split.json").read_text())
    train = a.worlds.split(",") if a.worlds else split["train"]
    groups = {"train": train}
    if a.val:
        groups["val"] = split["val"]
    render, tk = (None, None) if a.no_tokens else tokenizer()

    report: dict = {}
    for gname, worlds in groups.items():
        n_sessions = n_conv = 0
        fails: list[tuple[str, str, str]] = []
        reasons = collections.Counter()
        calls = consistent = 0
        incon = collections.Counter()
        incon_ex: list[str] = []
        good_calls = unsourced_conv = 0
        raw_calls = raw_unsourced = 0
        raw_cat = collections.Counter()
        bad_calls = bad_unsourced = 0
        slots = collections.Counter()
        flags = collections.Counter()
        sane = sane_bad = 0
        sources = collections.Counter()
        quotes = quote_ok = 0
        tok_old = tok_new = think_old = think_new = n_think = 0
        for rec in records(a.dirs, worlds):
            n_sessions += 1
            msgs = rec["messages"]
            # raw source accounting over every call (no conversion needed)
            prev_bad = False
            for i, m in enumerate(msgs):
                if m["role"] == "user":
                    prev_bad = False
                if m["role"] != "assistant":
                    continue
                bad = m.get("loss") is False
                try:
                    tr = T.derive_trace({"tool": m["tool"], "args": m["args"]}, msgs[:i], None, prev_bad, msgs[i + 1:], bad=bad, strict=False)
                except T.TraceError:
                    prev_bad = bad
                    continue
                if bad:
                    bad_calls += 1
                    bad_unsourced += bool(tr.unsourced)
                else:
                    raw_calls += 1
                    if tr.unsourced:
                        raw_unsourced += 1
                        for arg, _v in tr.unsourced:
                            raw_cat[arg if not arg.startswith("args.") else "args"] += 1
                prev_bad = bad
            traces, err = convert(rec)
            if err:
                reasons[err[0]] += 1
                fails.append((rec["id"], err[0], err[1][:160]))
                continue
            n_conv += 1
            new = [dict(m) for m in msgs]
            for i, tr in traces.items():
                m = msgs[i]
                text = tr.text()
                new[i]["think"] = text
                calls += 1
                probs = T.check_call(text, {"tool": m["tool"], "args": m["args"]}, msgs[:i], msgs[i + 1:])
                try:
                    if T.render(T.parse(text)) != text:
                        probs.append("parse/render round trip differs")
                except ValueError as e:
                    probs.append(f"unparsable: {e}")
                # every slot value is a closed word or a quote of the conversation's own words
                try:
                    sl = T.parse(text)
                    ctxm = T.fold(T.build_ctx(msgs[:i]).message).replace('"', "'")
                    allm = " | ".join(T.fold(t) for t in [ctxm] + [x["content"] for x in msgs[:i] if x["role"] == "user"]).replace('"', "'")
                    words = [sl["intent"][0], sl.get("verb"), (sl.get("scope") or [None])[0], (sl.get("refer") or [None])[0]]
                    words += [why for _n, why in sl.get("pick", []) if why] + ([sl["when"][1]] if sl.get("when", ("", ""))[0] == "w" else [])
                    closed = set(T.INTENTS) | set(T.VERBS) | set(T.SCOPES) | set(T.REFERS) | set(T.REASONS) | {"now"}
                    for wv in words:
                        if wv is not None:
                            quotes += 1
                            quote_ok += wv in closed
                    qs = list(sl.get("target", [])) + [v[1] for k, v in sl.items() if k in ("intent", "scope", "refer") and v[1]]
                    if sl.get("when", ("", ""))[0] in ("q", "e") and sl["when"][1]:
                        qs.append(sl["when"][1])
                    for qv in qs:
                        quotes += 1
                        quote_ok += T.fold(qv).replace('"', "'") in allm
                except ValueError:
                    quotes += 1
                if not probs:
                    consistent += 1
                else:
                    for p in probs:
                        incon[re.sub(r"[#@]?\d+", "N", p)[:60]] += 1
                    if len(incon_ex) < 8:
                        incon_ex.append(f"{rec['id']} msg {i}: {probs[0][:140]}")
                if m.get("loss") is not False:
                    good_calls += 1
                    unsourced_conv += bool(tr.unsourced)
                    for f in tr.flags:
                        flags[f] += 1
                    for k in T.SLOT_ORDER:
                        if tr.slots.get(k):
                            slots[k] += 1
                    for _a, _v, how in tr.sources:
                        sources[how.split(" #")[0]] += 1
                    w = tr.slots.get("when")
                    if w and w[0] == "q":
                        sane += 1
                        dv = T.date_values(m["args"])
                        sane_bad += not T.when_sane(w[1], dv)
                    if w and w[0] in ("e", "w"):
                        slots["when:" + ("now" if w[0] == "w" else "earlier")] += 1
            if tk is not None:
                tok_old += len(tk(render.render(msgs)[0])["input_ids"])
                tok_new += len(tk(render.render(new)[0])["input_ids"])
                for i in traces:
                    think_old += len(tk(msgs[i]["think"])["input_ids"])
                    think_new += len(tk(new[i]["think"])["input_ids"])
                    n_think += 1
        report[gname] = {
            "sessions": n_sessions, "converted": n_conv, "calls": calls, "consistent": consistent, "good_calls": good_calls,
            "unsourced_in_converted": unsourced_conv, "raw_good_calls": raw_calls, "raw_unsourced_calls": raw_unsourced,
            "raw_unsourced_by_arg": dict(raw_cat), "bad_calls": bad_calls, "bad_calls_with_unsourced": bad_unsourced,
            "tokens_old": tok_old, "tokens_new": tok_new, "think_tokens_old": think_old, "think_tokens_new": think_new,
            "think_calls": n_think, "failed": fails, "fail_reasons": dict(reasons), "flags": dict(flags), "slots": dict(slots),
            "when_quotes": sane, "when_quotes_contradicted": sane_bad, "slot_values": quotes, "slot_values_closed_or_quoted": quote_ok, "sources": dict(sources), "inconsistencies": dict(incon),
        }
        print(f"\n===== {gname}: worlds {','.join(worlds)}  ({n_sessions} sessions)")
        pct = lambda x, y: f"{100.0 * x / y:.2f}%" if y else "n/a"  # noqa: E731
        print(f"(a) trace-call consistency      {consistent}/{calls} calls = {pct(consistent, calls)}")
        for k, v in incon.most_common(8):
            print(f"      inconsistent: {k} x{v}")
        for ex in incon_ex:
            print(f"      e.g. {ex}") if gname == "train" else None
        print(f"    slot values that are a closed word or a quote of the user's words: {quote_ok}/{quotes} = {pct(quote_ok, quotes)}")
        print(f"(b) args without slot source    {unsourced_conv} over {good_calls} calls of converted sessions"
              f"   [before conversion: {raw_unsourced} of {raw_calls} good calls {dict(raw_cat)}; "
              f"bad calls carrying one: {bad_unsourced} of {bad_calls}]")
        print(f"(c) sessions converted          {n_conv}/{n_sessions} = {pct(n_conv, n_sessions)}   reasons {dict(reasons)}")
        if tk is not None and tok_old:
            print(f"(d) train tokens                old {tok_old:,} new {tok_new:,} ratio {tok_new / tok_old:.3f}"
                  f"   think only: old {think_old:,} new {think_new:,} ({think_old / max(n_think, 1):.1f} -> {think_new / max(n_think, 1):.1f} per call)")
        print(f"    slots on good calls {dict(slots)}")
        print(f"    quality flags {dict(flags)}; when quotes the expression contradicts: {sane_bad}/{sane}")
        print(f"    argument sources {dict(sources)}")
        if gname == "train":
            print("    not converted, by the first argument with no source:")
            cats: dict[str, list] = collections.defaultdict(list)
            for sid, reason, detail in fails:
                cats[reason + ":" + detail.split("=", 1)[0]].append(sid)
            for cat, ids in sorted(cats.items(), key=lambda kv: -len(kv[1])):
                print(f"      {cat} ({len(ids)}): {', '.join(i.replace('train-', '') for i in ids)}")
            if a.list:
                Path(a.list).write_text("".join(f"{sid}\t{reason}\t{detail}\n" for sid, reason, detail in fails))
        else:
            print("    not converted: " + ", ".join(f"{sid} ({reason})" for sid, reason, _d in fails))
    if a.json:
        Path(a.json).write_text(json.dumps(report, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
