"""Render the harness's raw frames to canonical, and score-ready JSONL.

    python3 render_frames.py --in out/afm.teacher.raw.jsonl \
                             --out out/afm.teacher.jsonl
    python3 render_frames.py --selftest          # the oracle path, no model
    python3 render_frames.py --serve             # one frame in, one line out

Three things happen to a raw row, in this order, and none of them repairs
anything:

 1. `stageB` is read as JSON and handed to `frame.from_flat`.  A frame that
    does not describe a legal set is `unrenderable` and its canonical is "".
 2. The VERBATIM-LITERAL rule (`crates/evalsuite/DEFECTS.md` #35): a
    content-bearing write argument must be made of words the member actually
    said.  A title the model composed out of nothing is `fabricated_literal`
    and its canonical is "".
 3. `check.py` reads the rendered string back.  A string it will not parse is
    `unparseable` and its canonical is "" — which cannot happen, because
    `frame.to_canonical` already re-parses, and is checked anyway.

The output is `infer.py`'s exact schema, so `run-model` scores it unchanged.
Reasons go to a SIDECAR (`<out>.reasons.jsonl`) rather than into the scored
file, which carries nothing the scorer does not read.

THE VERBATIM RULE, precisely.  The haystack is everything the member has said
in this session so far plus everything the harness has already produced in it,
which is the honest statement of "did this ever come from the member".  The
match is over WORDS of three characters or more, minus a small stopword set,
not over the whole phrase: measured against the 434 gold canonicals, a
whole-phrase substring rule rejects 105 legitimate literals (a member says
"the cabin" and the row is called "Cabin check-in") and 4 content-bearing
write arguments the corpus itself accepts.  The word rule rejects 0 of 434.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import frame  # noqa: E402
import check  # noqa: E402  (re-exported through frame's sys.path work)

CONTENT_ARGS = {"title", "description", "summary", "label", "reason", "name",
                "body", "content", "display_name", "note"}
STOPWORDS = {"the", "and", "for", "with", "that", "this", "from",
             "about", "into", "your", "its", "was", "are", "has", "had",
             "not", "but", "out", "all", "any", "one", "his", "her", "who"}
WORD = re.compile(r"[a-z0-9]+")


def words(text):
    return {w for w in WORD.findall((text or "").lower())
            if len(w) >= 3 and w not in STOPWORDS}


def content_literals(flat):
    """The content-bearing write arguments a flat frame carries."""
    out = []
    for cmd in flat.get("cmds") or []:
        for arg in cmd.get("args") or []:
            if arg.get("name") in CONTENT_ARGS and \
                    (arg.get("valueKind") or "literal") == "literal":
                value = arg.get("value")
                if value:
                    out.append(value)
    return out


def render_one(stage_b, haystack):
    """(canonical, reason). `canonical` is "" whenever `reason` is set."""
    if not stage_b:
        return "", "no_frame"
    try:
        flat = json.loads(stage_b)
    except Exception as exc:
        return "", "decode_error: %s" % exc
    if not isinstance(flat, dict):
        return "", "decode_error: frame is not an object"
    said = words(haystack)
    for literal in content_literals(flat):
        missing = sorted(words(literal) - said)
        if missing:
            return "", "fabricated_literal: %r (%s)" % (literal,
                                                        ", ".join(missing))
    try:
        built = frame.from_flat(flat)
        canonical = frame.to_canonical(built)
    except frame.Unrenderable as exc:
        return "", "unrenderable: %s" % exc
    except Exception as exc:
        return "", "unrenderable: %s: %s" % (type(exc).__name__, exc)
    try:
        check.parse(canonical)
    except Exception as exc:
        return "", "unparseable: %s" % exc
    return canonical, ""


# ------------------------------------------------------------------ batch mode


def read_raw(path):
    rows = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def run_batch(in_path, out_path):
    rows = read_raw(in_path)
    reasons_path = out_path + ".reasons.jsonl"
    history = {}
    counts = {"ok": 0, "empty": 0}
    by_reason = {}
    with open(out_path, "w", encoding="utf-8") as out, \
            open(reasons_path, "w", encoding="utf-8") as sidecar:
        for row in rows:
            key = (row["corpus"], row["session"])
            said = history.setdefault(key, [])
            haystack = " ".join(said + [row.get("request", "")])
            if row.get("error"):
                canonical, reason = "", "model_error: %s" % row["error"]
            else:
                canonical, reason = render_one(row.get("stageB", ""), haystack)
            said.append(row.get("request", ""))
            said.append(canonical)
            out.write(json.dumps({
                "corpus": row["corpus"], "session": row["session"],
                "turn": row["turn"], "mode": row.get("mode", ""),
                "model": row.get("model", "apple-foundation-models"),
                "request": row.get("request", ""),
                "prev_used": row.get("prev_used", "NONE"),
                "canonical": canonical,
            }) + "\n")
            sidecar.write(json.dumps({
                "corpus": row["corpus"], "session": row["session"],
                "turn": row["turn"], "reason": reason,
                "stageA": row.get("stageA", ""),
                "ms_a": row.get("ms_a", 0), "ms_b": row.get("ms_b", 0),
                "error": row.get("error", ""),
                "canonical": canonical,
            }) + "\n")
            if canonical:
                counts["ok"] += 1
            else:
                counts["empty"] += 1
                head = reason.split(":")[0]
                by_reason[head] = by_reason.get(head, 0) + 1
    total = max(1, len(rows))
    print("rendered %d/%d (%.1f%%) -> %s"
          % (counts["ok"], len(rows), 100.0 * counts["ok"] / total, out_path))
    for reason, count in sorted(by_reason.items(), key=lambda kv: -kv[1]):
        print("   %-24s %d" % (reason, count))
    print("reasons -> %s" % reasons_path)
    return 0


# ------------------------------------------------------------------ serve mode


def run_serve():
    """One JSON object per line in, one per line out. `--mode free` uses it."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except Exception:
            sys.stdout.write(json.dumps({"canonical": "",
                                         "reason": "bad request"}) + "\n")
            sys.stdout.flush()
            continue
        haystack = "%s %s" % (request.get("prev_used", ""),
                              request.get("request", ""))
        canonical, reason = render_one(request.get("stageB", ""), haystack)
        sys.stdout.write(json.dumps({"canonical": canonical,
                                     "reason": reason}) + "\n")
        sys.stdout.flush()
    return 0


# --------------------------------------------------------------- the self-test


def run_selftest(raw_path, out_path):
    """The ORACLE path: gold frames stood in for the model's.

    Every gold canonical is encoded to a frame and flattened to exactly the
    JSON the Swift harness writes, so the whole Python side — flattening,
    the verbatim rule, rendering, validation, the output schema — is
    exercised end to end with no model anywhere.  `run-model` over the result
    must reproduce `run-oracle`, which is what makes a later red a finding
    about the MODEL and not about this code.
    """
    rows = frame.gold_turns()
    written = 0
    with open(raw_path, "w", encoding="utf-8") as fh:
        previous = {}
        for row in rows:
            key = (row["corpus"], row["session"])
            flat = frame.to_flat(frame.encode(check.parse(row["canonical"])))
            fh.write(json.dumps({
                "corpus": row["corpus"], "session": row["session"],
                "turn": row["turn"], "mode": "selftest",
                "model": "gold-frames",
                "request": row["request"],
                "prev_used": previous.get(key, "NONE"),
                "stageA": "", "stageB": json.dumps(flat, sort_keys=True),
                "error": "", "ms_a": 0, "ms_b": 0, "canonical": "",
            }) + "\n")
            previous[key] = row["canonical"]
            written += 1
    print("wrote %d synthetic frames -> %s" % (written, raw_path))
    run_batch(raw_path, out_path)
    # the canonical each frame rendered to must be TREE-EQUAL to gold
    bad = 0
    with open(out_path, encoding="utf-8") as fh:
        for line, row in zip(fh, rows):
            got = json.loads(line)["canonical"]
            if not got or check.parse(got) != check.parse(row["canonical"]):
                bad += 1
                if bad <= 10:
                    print("   MISMATCH %s/%s t%s\n     gold %s\n     got  %s"
                          % (row["corpus"], row["session"], row["turn"],
                             row["canonical"], got))
    print("selftest: %d/%d tree-equal to gold" % (len(rows) - bad, len(rows)))
    return 0 if bad == 0 else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="in_path")
    ap.add_argument("--out", dest="out_path")
    ap.add_argument("--serve", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.serve:
        return run_serve()
    if args.selftest:
        return run_selftest(args.in_path or os.path.join(HERE, "out",
                                                         "_selftest.raw.jsonl"),
                            args.out_path or os.path.join(HERE, "out",
                                                          "_selftest-gold.jsonl"))
    if not args.in_path or not args.out_path:
        ap.error("--in and --out are required")
    return run_batch(args.in_path, args.out_path)


if __name__ == "__main__":
    sys.exit(main())
