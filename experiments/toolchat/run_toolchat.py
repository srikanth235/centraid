"""Two-tool chat probe: the model writes SQL, we run it, it answers.

    python3 run_toolchat.py --out out/sonnet-15 --model sonnet

A BUILD-TIME measurement of the ceiling. It suspends the project's rule that
the model never writes SQL, for the same reason it uses Sonnet at all: to find
out what is reachable when the representation we invented is out of the way.
Nothing here is a shipping design.

WHAT IS DIFFERENT FROM THE FRAME HARNESS

  * The model sees the WHOLE session -- every question the person asked and
    every result it got back -- not one canonical string.  In the frame runs
    each turn was a fresh stateless process given one line of history, and 14
    of the 29 dev-15 turns are follow-ups.
  * The model can LOOK THINGS UP.  "the trip group" -> `Tahoe Trip` was
    unanswerable by construction before; now it is a query.
  * Scoring is by OUTCOME -- the row ids returned -- so two different queries
    that return the same rows both pass.  The frame scorer failed
    `max started_at of (...)` against `first 1 of (... ordered by desc)`,
    which are the same question.

DISCIPLINE, unchanged from the frame runs: free-running (the model's own
results thread forward, never gold), raw text written to the stream before
anything parses it, and a malformed or empty reply is a FAILURE that is
counted and never repaired, retried or re-prompted.  A SQL error is NOT a
failure -- it is a tool result, handed back verbatim so the model can fix its
own query, exactly as a real tool would.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import re
import sqlite3
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", ".."))
EVAL = os.path.join(REPO, "crates", "evalsuite")
WORLD = {"suite": os.path.join(REPO, "target", "eval-world", "world.db"),
         "blind": os.path.join(REPO, "target", "eval-world", "world.db"),
         "holdout": os.path.join(REPO, "target", "eval-world-2", "world.db")}

# The 34 domain tables, from the Kind->table mapping in
# crates/evalsuite/grammar/GRAMMAR.md:135-160 plus the facet and link tables
# it names.  NOT the other 218: the vault carries access_*, blob_*, audit_*
# and backup_* infrastructure that no question in the corpus is about, and
# sending all 252 costs ~35-46k tokens against ~2.4-3.1k for these.
TABLES = """core_event schedule_task knowledge_note core_document core_party
tally_friend people_profile people_important_date social_contact_channel
core_activity tally_obligation core_content_item media_asset core_collection
core_place tally_expense tally_group social_circle social_circle_member
tally_settlement core_account core_transaction schedule_project locker_item
locker_item_field tally_expense_line_item schedule_section
core_party_identifier schedule_calendar tally_recurring_expense
core_link core_tag core_attachment core_collection_entry
knowledge_annotation""".split()

MAX_ROWS = 50
MAX_CELL = 120         # characters per returned value

# Queries per turn. THREE, not an arbitrary six: on the shipping target -- a
# small model on a phone -- every query is a round trip the person waits for,
# so the budget is a product constraint and not a harness knob.
#
# The budget is STATED to the model in the system prompt rather than sprung on
# it, and when it runs out the model gets one FINAL call that may not query.
# Running out and being cut off mid-thought is a harness artefact scored as a
# wrong answer; running out and having to answer or ask is what the product
# does. `s05` t1 ("which Neha is that?") is the case that showed this: the
# name lives only inside an event's summary text and no edge joins that event
# to a party, so the model checked the organizer, `core_link`, `core_tag` and
# every candidate's profile -- four routes -- before it could honestly say it
# could not tell. Proving a thing ABSENT always costs more queries than
# finding it, so a hard cut-off penalises exactly the turns where the right
# answer is "the vault cannot tell you that".
MAX_QUERIES = 3
LAST_CALL = ("You have used all %d of your queries and cannot run another. "
             "Answer now with what you have, or ASK a clarifying question if "
             "you genuinely cannot tell." % MAX_QUERIES)

READ_ONLY = re.compile(r"^\s*(select|with)\b", re.I)
BANNED = re.compile(r"\b(insert|update|delete|drop|alter|create|attach|"
                    r"detach|pragma|vacuum|replace)\b", re.I)

STEP = re.compile(r"^\s*(READ|WRITE|ANSWER|ASK|NOTHING)\b[:\s]*(.*)$",
                  re.I | re.S)

# LOCAL MODELS ONLY, and the asymmetry is reported rather than hidden: a
# grammar is a decoding constraint llama.cpp can apply and `claude -p` cannot,
# so Sonnet runs unconstrained and a malformed reply from it is a failure.
#
# Without this, both small models answer a menu with its label. Measured: the
# 350M replied "READ" -- two tokens, no SQL -- on all 29 turns, and Qwen3.5-2B
# replied "ASK". Both know the format (on a 23-token toy prompt each emits
# "READ: SELECT 1" correctly); given the five options they return the option
# name. Requiring a character after the label makes that reply unsayable, so
# what is measured is the query rather than the protocol.
#
# The FINAL call, after the query budget is spent, drops `read` from the root
# so "run another query" is not merely discouraged but impossible.
_TAIL = """
write ::= "WRITE: " [a-zA-Z_.]+ " " line
answer ::= "ANSWER: " line
ask ::= "ASK: " line
nothing ::= "NOTHING"
line ::= [^\\n]+
"""
GBNF_STEP = ('root ::= read | write | answer | ask | nothing\n'
             'read ::= "READ: " ("SELECT" | "WITH") " " line\n') + _TAIL
GBNF_FINAL = 'root ::= write | answer | ask | nothing\n' + _TAIL


GRAMMAR = os.path.join(EVAL, "grammar", "GRAMMAR.md")
MAP_ROW = re.compile(r"^\|\s*`([^`]+)`\s*\|\s*`?([^|`]+?)`?\s*\|"
                     r"\s*\*?\*?([a-z ]+?)\*?\*?\s*\|\s*(`[a-z_]+`[^|]*)\|")

# What a table is FOR, which the column names do not say. The 34 tables are
# a flat list of names to a model: `core_document` and `locker_item` are
# equally plausible homes for "the renters insurance policy" until something
# says one is filed paperwork and the other is stored secrets. Parsed from
# the Kind -> (entity, door, base table) table in GRAMMAR.md:135-160 rather
# than retyped, so it follows the spec if the spec moves.
DOORS = {"agenda": "Agenda, the diary", "tasks": "Tasks",
         "notes": "Notes", "docs": "Docs, filed paperwork",
         "people": "People", "photos": "Photos", "tally": "Tally, money",
         "locker": "Locker, stored secrets and logins"}


def kind_map():
    """base table -> [(kind name, door), ...]. One table can serve two."""
    out = {}
    with open(GRAMMAR, encoding="utf-8") as fh:
        for line in fh:
            m = MAP_ROW.match(line)
            if m:
                kind, _entity, door, cell = (x.strip() for x in m.groups())
                # A cell may name more than one table: `core_party via
                # tally_friend` and `core_content_item`+`media_asset`. Taking
                # only the first labels the second "internal", which is worse
                # than no annotation -- it tells the model not to look there.
                tables = re.findall(r"`([a-z_]+)`", cell)
                for i, table in enumerate(tables):
                    out.setdefault(table, []).append(
                        (kind, door) if i == 0 else (kind + " (joined)", door))
    if not out:
        raise AssertionError("%s: the Kind->table mapping did not parse; the "
                             "schema would go out unannotated" % GRAMMAR)
    return out


def schema_text(db):
    """Columns, types, foreign keys -- and what each table is for."""
    con = sqlite3.connect("file:%s?mode=ro" % db, uri=True)
    kinds = kind_map()
    lines = []
    for table in TABLES:
        cols = [(r[1], r[2]) for r in con.execute("pragma table_info(%s)" % table)]
        if not cols:
            continue
        fks = {r[3]: r[2] for r in
               con.execute("pragma foreign_key_list(%s)" % table)}
        parts = []
        for name, typ in cols:
            text = "%s %s" % (name, (typ or "").lower() or "any")
            if name in fks:
                text += "->%s" % fks[name]
            parts.append(text)
        served = kinds.get(table)
        if served:
            gloss = "; ".join(
                '"%s" through %s' % (kind, DOORS.get(door, door))
                for kind, door in served)
        else:
            gloss = "internal: joined through, never asked for directly"
        lines.append("-- %s" % gloss)
        lines.append("%s(%s)" % (table, ", ".join(parts)))
    con.close()
    return "\n".join(lines)


def today(corpus):
    with open(os.path.join(EVAL, "%s.json" % corpus), encoding="utf-8") as fh:
        return json.load(fh)["today"]


SYSTEM = """\
You answer questions about one person's own vault, a local SQLite database.

TODAY IS %(weekday)s %(today)s. Every relative date -- "friday", "tomorrow",
"the 21st", "last week" -- resolves against that date, not against any other
calendar.

You have two tools. Reply with exactly ONE of these, nothing else:

  READ: <a single SQL SELECT>
  WRITE: <command name> <json arguments>
  ANSWER: <the answer, in one short sentence>
  ASK: <a clarifying question, when the request is genuinely ambiguous>
  NOTHING

READ runs your SQL and gives you the rows back. Use it to look a thing up
before you filter on it -- the person says "the trip group" and the row may be
called "Tahoe Trip". SELECT only.

YOU GET %(queries)d QUERIES PER TURN. The person is waiting on each one, so
spend them deliberately: prefer one query that joins over three that look
things up one at a time. If you run out, you will be asked to answer with what
you have. Not finding something in %(queries)d queries is itself informative --
if the vault cannot connect what the person is asking about, say so or ASK,
rather than guessing at which row they meant.

ALWAYS select the row's own id column FIRST (task_id, party_id, event_id and
so on). The ids are how your answer is checked.

When you have the rows that answer the question, your LAST READ is taken as
your answer, then say ANSWER. Do not run more queries after you have the
answer -- the last one is the one that counts.

Rows that are deleted have deleted_at set. Live rows have it null. Unless the
person asks about deleted or binned things, filter them out.

"What's on Wednesday", "anything happening on the 21st", "what have I got on"
-- an open question about a day or a period is NOT just the diary. It is
events, plus tasks that are not completed, plus important dates such as
birthdays, which live on none of the other two. Query all three and answer
with the union. [GRAMMAR.md R-T2]

Answer with the ROWS unless the person asked for a single number. "What did we
spend on the trip?" wants the expenses; "what's that come to?" wants the
total. When in doubt return the rows -- a total can be read off them, and the
rows cannot be read back out of a total.

A task is only "due" or "overdue" if it is NOT completed. Money "owed" or
"outstanding" is money whose settled_at is null.

Use ASK when the request genuinely matches several things and you cannot tell
which. Use NOTHING when the person withdraws the request. Use ANSWER with a
plain refusal when the vault does not hold that kind of information at all.

THE DATABASE
%(schema)s
"""


class Runner:
    def __init__(self, args):
        self.args = args
        self.lock = threading.Lock()
        self.stream = open(args.stream, "a", encoding="utf-8")
        self.rows = []
        db = WORLD[args.corpus]
        day = today(args.corpus)
        import datetime
        self.system = SYSTEM % {
            "today": day,
            "weekday": datetime.date.fromisoformat(day).strftime("%A"),
            "schema": schema_text(db),
            "queries": MAX_QUERIES,
        }
        self.db = db

    def write_row(self, row):
        with self.lock:
            self.stream.write(json.dumps(row) + "\n")
            self.stream.flush()
            self.rows.append(row)

    # ---- the tool ----------------------------------------------------
    def read(self, sql):
        """Run one SELECT. Errors come back to the model, they are not ours."""
        if not READ_ONLY.match(sql) or BANNED.search(sql):
            return None, ("rejected: read takes a single SELECT and this is "
                          "not one")
        con = sqlite3.connect("file:%s?mode=ro" % self.db, uri=True)
        con.row_factory = sqlite3.Row
        try:
            cur = con.execute(sql)
            fetched = cur.fetchmany(MAX_ROWS + 1)
            names = [d[0] for d in cur.description or []]
        except Exception as exc:
            con.close()
            return None, "sql error: %s" % exc
        con.close()
        more = len(fetched) > MAX_ROWS
        fetched = fetched[:MAX_ROWS]
        out = []
        for r in fetched:
            out.append({k: (str(r[k])[:MAX_CELL] if r[k] is not None else None)
                        for k in names})
        return out, ("%d row(s)%s" % (len(out), ", more were cut off" if more
                                      else ""))

    # ---- the model ---------------------------------------------------
    def call(self, transcript, final=False):
        if self.args.backend == "llama":
            return self.call_llama(transcript, final)
        return self.call_claude(transcript)

    def call_llama(self, transcript, final=False):
        """A local llama-server, so the SAME harness drives both models.

        `cache_prompt` and NOT `--cache-reuse`: on a hybrid architecture
        llama-server prints that it is disabling cache_reuse and then returns
        slot-history-dependent answers for identical prompts, which silently
        destroys determinism. Temperature 0 and top_k 1 for the same reason.
        """
        import urllib.request
        body = json.dumps({
            "messages": [{"role": "system", "content": self.system},
                         {"role": "user", "content": transcript}],
            "temperature": 0, "top_k": 1, "cache_prompt": True,
            "n_predict": self.args.predict,
            # THINKING OFF, or every turn is a spurious failure. Qwen3.5 and
            # Gemma route the whole reply into `reasoning_content`, return
            # `content: ""` and stop on `length`. Measured on Qwen3.5-2B: a
            # bare "Reply with exactly: READ: SELECT 1" burned all 80 tokens
            # thinking about it and answered nothing. Both keys are sent
            # because which one a build honours varies; both were verified to
            # work on this one, and sending a key a build ignores is inert.
            "reasoning_effort": "none",
            "chat_template_kwargs": {"enable_thinking": False},
            "grammar": GBNF_FINAL if final else GBNF_STEP,
        }).encode("utf-8")
        req = urllib.request.Request(
            "%s/v1/chat/completions" % self.args.server.rstrip("/"),
            data=body, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=self.args.timeout) as fh:
                reply = json.loads(fh.read().decode("utf-8"))
        except Exception as exc:
            return "", {}, "llama: %s" % exc
        try:
            choice = reply["choices"][0]
        except Exception:
            return "", {}, "llama: no choice in %s" % json.dumps(reply)[:200]
        text = (choice.get("message") or {}).get("content") or ""
        usage = reply.get("usage") or {}
        # A truncated reply is a FAILURE and is recorded as one, never retried.
        if choice.get("finish_reason") == "length" and not text.strip():
            return "", usage, "empty output, stopped on length"
        return text, usage, ""

    def call_claude(self, transcript):
        cmd = [self.args.claude, "-p", transcript,
               "--model", self.args.model,
               "--system-prompt", self.system,
               "--restricted", "--strict-mcp-config",
               "--mcp-config", '{"mcpServers":{}}',
               "--setting-sources", "", "--disable-slash-commands",
               "--no-session-persistence", "--tools", "",
               "--output-format", "json"]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True,
                                  timeout=self.args.timeout, cwd=self.args.cwd)
        except subprocess.TimeoutExpired:
            return "", {}, "timeout after %ss" % self.args.timeout
        if proc.returncode != 0:
            return "", {}, "exit %d: %s" % (proc.returncode,
                                            (proc.stderr or "")[:300])
        try:
            reply = json.loads(proc.stdout)
        except Exception as exc:
            return "", {}, "cli json: %s" % exc
        if reply.get("is_error") or reply.get("subtype") != "success":
            return "", reply.get("usage") or {}, "cli error"
        return (reply.get("result") or ""), (reply.get("usage") or {}), ""

    # ---- one turn ----------------------------------------------------
    def turn(self, corpus, session, index, request, history):
        started = time.time()
        steps, last_rows, last_sql, writes = [], None, None, []
        verdict, said, error = "", "", ""
        queries = 0
        forced = False
        # MAX_QUERIES reads, then ONE final call that may not read.
        for _ in range(MAX_QUERIES + 1):
            spent = queries >= MAX_QUERIES
            lines = list(history)
            lines.append("The person says: %s" % request)
            for step in steps:
                lines.append(step)
            if spent:
                lines.append(LAST_CALL)
                forced = True
            text, usage, err = self.call("\n".join(lines), final=spent)
            # RAW FIRST -- before anything parses it
            self.write_row({"corpus": corpus, "session": session,
                            "turn": str(index), "request": request,
                            "kind": "raw", "raw_text": text, "error": err,
                            "usage": usage})
            if err:
                error = err
                break
            match = STEP.match(text.strip())
            if not match:
                error = "unparseable step"
                said = text.strip()[:400]
                break
            verb = match.group(1).upper()
            body = (match.group(2) or "").strip()
            if verb == "READ":
                if spent:
                    # It was told it had none left and asked anyway. That is
                    # the model's own failure to follow the protocol, not a
                    # cut-off, and it is recorded as one.
                    error = "queried after its budget was spent"
                    break
                sql = body.strip().strip("`").strip()
                if sql.lower().startswith("sql"):
                    sql = sql[3:].lstrip()
                queries += 1
                rows, note = self.read(sql)
                steps.append("You ran: %s" % sql)
                if rows is None:
                    steps.append("It failed: %s" % note)
                else:
                    last_rows, last_sql = rows, sql
                    steps.append("It returned %s:\n%s"
                                 % (note, json.dumps(rows)[:4000]))
                continue
            if verb == "WRITE":
                writes.append(body)
                steps.append("You wrote: %s" % body)
                steps.append("It succeeded. (recorded, not executed)")
                continue
            verdict, said = verb, body
            break
        else:
            error = error or "no verdict after the final call"
        row = {"corpus": corpus, "session": session, "turn": str(index),
               "request": request, "kind": "turn", "verdict": verdict,
               "said": said, "sql": last_sql, "rows": last_rows,
               "writes": writes, "queries": queries, "forced": forced,
               "steps": len(steps), "error": error,
               "ms": round(1000.0 * (time.time() - started), 1)}
        self.write_row(row)
        # the model's OWN history threads forward, never gold
        history.append("The person says: %s" % request)
        history.extend(steps)
        if verdict:
            history.append("You said: %s %s" % (verdict, said))
        return row

    def session(self, corpus, session, turns):
        history = []
        for index, request in enumerate(turns):
            self.turn(corpus, session, index, request, history)

    def run(self, work_items):
        work = queue.Queue()
        for item in work_items:
            work.put(item)
        total = sum(len(t) for _, _, t in work_items)
        done, started = [0], time.time()

        def worker():
            while True:
                try:
                    corpus, session, turns = work.get_nowait()
                except queue.Empty:
                    return
                self.session(corpus, session, turns)
                with self.lock:
                    done[0] += len(turns)
                    print("%d/%d  %.0fs" % (done[0], total,
                                            time.time() - started))

        threads = [threading.Thread(target=worker)
                   for _ in range(self.args.slots)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", default="suite")
    ap.add_argument("--out", default=os.path.join(HERE, "out", "toolchat"))
    ap.add_argument("--stream", default=None)
    ap.add_argument("--sessions", default=None,
                    help="comma-separated session ids; default dev15")
    ap.add_argument("--slots", type=int, default=5)
    ap.add_argument("--timeout", type=int, default=600)
    ap.add_argument("--backend", choices=["claude", "llama"], default="claude",
                    help="claude = `claude -p`; llama = a local llama-server")
    ap.add_argument("--server", default="http://127.0.0.1:8080",
                    help="llama-server base url, for --backend llama")
    ap.add_argument("--predict", type=int, default=512,
                    help="max tokens per reply, for --backend llama")
    ap.add_argument("--claude", default="claude")
    ap.add_argument("--model", default="sonnet")
    ap.add_argument("--cwd", default="/tmp")
    args = ap.parse_args()

    if args.sessions:
        want = set(args.sessions.split(","))
    else:
        path = os.path.join(REPO, "experiments", "qwen-sanity", "dev15.json")
        want = set(json.load(open(path, encoding="utf-8"))["sessions"]["suite"])

    with open(os.path.join(EVAL, "%s.json" % args.corpus), encoding="utf-8") as fh:
        corpus = json.load(fh)
    items = [(args.corpus, s["id"], [t["request"] for t in s["turns"]])
             for s in corpus["sessions"] if s["id"] in want]
    missing = want - {s for _, s, _ in items}
    if missing:
        raise SystemExit("unknown sessions: %s" % sorted(missing))

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    if args.stream is None:
        args.stream = "%s.stream.jsonl" % args.out
    runner = Runner(args)
    print("%d sessions, %d turns, schema %d chars"
          % (len(items), sum(len(t) for _, _, t in items),
             len(schema_text(runner.db))))
    runner.run(items)
    with open("%s.jsonl" % args.out, "w", encoding="utf-8") as fh:
        for row in runner.rows:
            if row.get("kind") == "turn":
                fh.write(json.dumps(row) + "\n")
    print("wrote %s.jsonl" % args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
