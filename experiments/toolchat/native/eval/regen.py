"""Gold from the reference run: what the runtime did with the reference calls, written as an accepted effect, and the
convention that explains why it differs from the gold on file.

    imported by build_sets.py (`refreeze`) and authored/build.py (`--gold-from-ref`); not a command

SPEC §13: gold is an effect derived by running the reference calls through the runtime. D-1044-11: the harness applies
the conventions, so when the runtime changes the gold is regenerated, and versioned.
`regen_session` takes a session in the gold format and its reference run (run.py `--model ref`, or the replay of
authored/build.py) and returns the session with the gold of every stale turn replaced, plus one change row per
changed turn.

A turn is stale in two cases.
  failing  the reference run does not pass the gold on file. The gold becomes one accept derived from the run's
           terminal effect (`derive_accept`), in the vocabulary of gold.py, so that `score.judge_accept` passes it
           against that very run; the derivation is re-scored before it is used.
  tighter  the run passes the gold, but a convention says the gold is a superseded reading: an `ask` that names fewer
           candidates than the options the runtime now composes (D-1044-9), or an alternative accept that is the
           pre-D-1044-7 reading of a `status = open` read. The alternative is dropped, the ask is replaced.
Every other turn is left as it is, alternatives, `also` checks and tags included.

The conventions of the runtime's readouts (#1044) are read from the reply notes: `container` (a list's or a parent task's
tasks with no status condition are the active rows), `status-words` (open, left, remaining, still, overdue add
`status = open`), `next` (the nearest upcoming one: limit 1 from today) and `last-one` (the latest past one).

`name-match` is report only (`REPORT_ONLY`): the first call of the reference now resolves a nickname or an accented
name and ends the turn on that row, where the authored reference dead-ends on purpose and goes on to the rows the
question asks for, so the effect the run derives may be the wrong answer. Such a turn is reported with that label, the
old gold and the derived accept, and keeps its gold (`held`): the reference calls are repaired at the source.

D-1044-13 (the gold rulings of the persistent-failure read) adds three kinds of rule to the same machinery.
  explain  a convention that explains a change the run makes (`what-else` also for "besides X" and for rows written or
           asked about earlier, `focus-wins`, `bulk-cap` for a request bounded by its wording, `due-active`, and the
           outcomes the runtime composes itself: `composed-ask`, `composed-decline`, `composed-refusal`)
  widen    a convention that adds an accepted alternative to the gold of a turn, derived from the gold, the reference
           calls, the world and, for `composed-answer`, the run's own reads (`superlative`, `group-or-value`,
           `container-or-row`, `narrowed-balance`, `composed-answer`; WIDENING)
  rewrite  a rule over the message that rewrites the reference calls and the gold before the reference run
           (`messaging`, `due-active`, `kindless`), and FIXES, a table of hand corrections keyed by (session id, turn)
           with the one-line reason of each. `prepare_session` applies both; `python3 regen.py refreeze` prepares the sets and
           then runs build_sets.refreeze over them (the reference run follows the rewritten calls).
The blind gold audit (G1) added four more, read over the message and the session so far (the section "K1 to K4"):
  `kindless`         (K1, explain + rewrite) "what's left this weekend" and "what's still on today" name no kind: "left"
                     reads the tasks or events of the turn before (tasks as a first read), "on" the calendar (events)
                     (D-1044-15, B3b) a span question with no "on", no "left" and no task word ("what's the plan for next
                     week", "anything next weekend", "what does next week look like", "what've i got next monday") is the
                     calendar too, and a fragment ("and tomorrow", "and the 14th") keeps the kind of the turn before
  `debt-or-person`   (D-1044-15, B6, widen) "who owes me", "who do i owe", "who's that to" about debts: the open debt rows
                     and the people they link to are both answers
  `narrowed-balance` (K2, widen) "just the household one" after a person's balance: the group's net or the person's part
                     of the balance in the group's currency
  `broken-off`       (K3, explain) a request broken off mid-sentence runs only the last complete request
  `bare-plural`      (K4, explain) several rows fit a name given by a bare plural and nothing says all, every, each,
                     both or everyone: the ask over them, not the write to every row (the runtime's own closed list)
M5d and M5e (ruled on val) add one, over the message and the run:
  `series-ask`       (explain) a write by the name of a recurring series (two or more live events, or two or more live
                     tasks, of one name) with no date, ordinal, word that picks one or word for all in the message is the
                     runtime's ask over the series; an old gold that wrote to one instance (the next upcoming, the one
                     open) is replaced by it. A pronoun for a name the message itself states ("Order composite resin,
                     push it to monday") picks nothing
A fixed turn is pinned: a run that fails its gold is UNEXPLAINED, never re-derived. Test ids are never in FIXES.

API (everything else is internal):
  regen_session(session, record) -> (session, rows)   the session with the stale gold replaced, one change row per turn
                                                      changed, UNEXPLAINED or held (those two keep the old gold)
  prepare_session(session, fixes=True) -> (session, rows)  the rewrites and the fixes, before the reference run; with
                                                      fixes=False the conventions only (a test session: D-1044-14)
  regen_turn(gold_turn, steps, sess, i) -> dict         one turn, in the state `Sess` has been left in
  derive_accept(eff, ids, old, steps) -> (accept, notes) the accept for a terminal effect; raises Underivable
  explain(old, new, cx) -> (convention, evidence)       the convention that explains old -> new, or None
  summarize(rows, sessions, turns), show_gold(accepts)   counts by convention; a gold on one line
  composed_marks(session, record) -> {(turn, step)}      the calls marked `bad` at which the runtime composed a decline
                                                         or an ask itself and ended the turn (D-1044-10), or applied the
                                                         write the old gold accepts (`composed-apply`): no error
  composed_ends(session, record) -> [dict]               the turns the runtime ended by composition before the reference
                                                         calls ran out, each named `composed-ask|decline|refusal|answer|
                                                         apply`
  composed_problems(session, record) -> [dict]           those whose reference was heading for a write: verify problems
                                                         (never a `composed-apply`: a diff the gold does not accept is the
                                                         turn's gold failing, UNEXPLAINED)
  composed_counts(sessions, records) -> {convention: n}  the turns a set ends by composition, per convention

A change is explained by a convention, looked at from the reference calls, the message, the old gold and the new
effect, and never guessed (`CONVENTIONS`, in the order they are tried). A change no convention fits is UNEXPLAINED:
the old gold stays and the row says what was derived. Checks the old accept carried (`also` diffs, `settle`,
`reveal`, `already`, the matchers of a row spec) are kept when the run still satisfies them; the row lists what was
kept and what was dropped.
"""

from __future__ import annotations

import copy
import hashlib
import itertools
import json
import re
import sys
import unicodedata
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

import gold
from lib import SECTION_KIND, load_world, turn_effect
from score import Ids, judge_accept, match_value, value_list_match

ROW_CAP = 12  # crates/nativetools/src/meta.rs: a write over this many rows is the runtime's to ask about
VOLATILE = {"completed"}  # fields the runtime stamps with the time of the write: any value will do
CONVENTIONS = ("bulk-cap", "bare-plural", "series-ask", "refusal", "ask-options", "composed-refusal", "composed-ask",
               "composed-decline", "name-match", "status", "what-else", "container", "status-words", "next", "last-one",
               "due-active", "focus-wins", "superlative", "group-or-value", "container-or-row", "debt-or-person", "messaging",
               "kindless", "narrowed-balance", "broken-off")
REPORT_ONLY = ("name-match",)  # reported with the old and the derived gold, never applied
WIDENING = ("superlative", "group-or-value", "container-or-row", "debt-or-person",
            "narrowed-balance")  # conventions that add an alternative, never replace
REWRITES = ("messaging", "due-active", "kindless")  # conventions that also rewrite the reference calls (prepare_session)
UNEXPLAINED = "UNEXPLAINED"
KINDS_WITH_EFFECT = ("rows", "value", "act", "ask", "decline")
# D-1044-8 and D-1044-13 (G2): "what else", "the other ones", "besides X", "apart from X", "the one after"
WHAT_ELSE = re.compile(r"\b(?:else|other|others|remaining|besides|except|(?:apart|aside) from|ones? after)\b", re.I)
MATCHED = re.compile(r'matched ".*?" to #\d+')
# the notes the runtime's conventions add to a reply (crates/nativetools/src/ground.rs, session.rs; #1044)
NOTE_CONTAINER = "(active rows; add status = completed or all for the rest)"
NOTE_STATUS_WORDS = "status: the message asks what is left; used status = open."
NOTE_NEXT = "next: the message asks for the next one;"
NOTE_LAST = "last: the message asks for the last one;"
DONE = ("completed", "cancelled")  # the statuses the active-rows readings leave out


class Underivable(Exception):
    """The reference run has no terminal effect that gold can name."""


# ---------------------------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------------------------


def num(x) -> int | float:
    """An amount as gold writes it: 36 for 36.0."""
    f = float(x)
    return int(f) if f.is_integer() else f


def canon(value) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False)


def canon_diff(diff: dict | None) -> str:
    diff = diff or {}
    return canon({"rows": sorted(canon(r) for r in diff.get("rows", [])),
                  "links": sorted(canon(link) for link in diff.get("links", []))})


def canon_accept(accept: dict) -> str:
    """A form two accepts share when they say the same: rows, candidates, row specs and links as sets (rows in order
    when the order counts), the key order of every object ignored."""
    out = copy.deepcopy(accept)
    if out.get("type") == "rows" and not out.get("order"):
        out["rows"] = sorted(out["rows"])
    if out.get("type") == "ask":
        out["candidates"] = sorted(out["candidates"])
    if "diff" in out:
        out["diff"] = {"rows": sorted(canon(r) for r in out["diff"].get("rows", [])),
                       "links": sorted(canon(link) for link in out["diff"].get("links", []))}
    if "already" in out:
        out["already"] = sorted(out["already"])
    return canon(out)


def fold(text: str) -> str:
    """Accents and case folded, as the runtime folds a name (`Lucía` is `lucia`)."""
    text = unicodedata.normalize("NFKD", text)
    return "".join(c for c in text if not unicodedata.combining(c)).casefold()


def words(text: str, folded: bool) -> set[str]:
    """The words of a name: case folded, and with accents folded too when `folded` (the old matcher did not)."""
    text = re.sub(r"['’]s\b", "", text)
    return set(re.findall(r"[^\W_]+", fold(text) if folded else text.casefold()))


def world_status(task: dict) -> str:
    """The status `nativetools seed` gives a world task (seed.rs): a completed time wins over an in_progress status."""
    if task.get("status") == "completed" or task.get("completed"):
        return "completed"
    if task.get("status") in ("in_progress", "cancelled"):
        return task["status"]
    return "open"


def literal(value):
    """A value the way a gold spec writes it: money as its amount (score.match_value reads a money dict only as the
    run's side), everything else as it is."""
    if isinstance(value, dict) and "amount" in value:
        return num(value["amount"])
    return value


def key_of(ids: Ids, vid: str) -> str | None:
    """The gold name of a vault id: its world key, or `+n` for the n-th row created in earlier turns."""
    if vid in ids.by_id:
        return ids.by_id[vid]
    if vid in ids.created:
        return f"+{ids.created.index(vid) + 1}"
    return None


def id_of(ids: Ids, key: str) -> str | None:
    try:
        return ids.id(key)
    except KeyError:
        return None


def ids_of(ids: Ids, keys: list[str]) -> list[str] | None:
    out = [id_of(ids, k) for k in keys]
    return None if None in out else out  # type: ignore[return-value]


# ---------------------------------------------------------------------------------------------
# The where language, as far as the status convention needs it
# ---------------------------------------------------------------------------------------------

STATUS_CLAUSE = re.compile(
    r"""^status\s*(?:(?P<op>!=|=)\s*(?P<one>"[^"]*"|'[^']*'|\w+)|\s+in\s*\((?P<many>[^)]*)\))$""", re.I)


def clauses(where: str) -> list[str]:
    """The conditions of a `where`, split at `and` outside quotes."""
    quoted: list[str] = []

    def stash(m: re.Match) -> str:
        quoted.append(m.group(0))
        return f"\0{len(quoted) - 1}\0"

    flat = re.sub(r"\"[^\"]*\"|'[^']*'", stash, where)
    return [re.sub(r"\0(\d+)\0", lambda m: quoted[int(m.group(1))], part).strip()
            for part in re.split(r"\s+and\s+", flat, flags=re.I)]


def status_clauses(where: str) -> list[tuple[str, frozenset[str]]]:
    """The conditions on `status` of a `where` as (op, values), op one of = != in."""
    out = []
    for clause in clauses(where):
        m = STATUS_CLAUSE.match(clause)
        if not m:
            continue
        if m.group("op"):
            out.append((m.group("op"), frozenset({m.group("one").strip("\"'").casefold()})))
        else:
            out.append(("in", frozenset(v.strip().strip("\"'").casefold() for v in m.group("many").split(","))))
    return out


def open_reading(op: str, values: frozenset[str]) -> str | None:
    """`pos` when the clause names open and leaves in_progress to the rule of D-1044-7 (`= open`, `in ("open")`),
    `neg` for `!= open`, None for a clause the rule does not touch (`!= completed`, `in ("open", "in_progress")`)."""
    if "open" not in values:
        return None
    if op == "!=":
        return "neg"
    return "pos" if "in_progress" not in values else None


# ---------------------------------------------------------------------------------------------
# The session in hand, and the turn in hand
# ---------------------------------------------------------------------------------------------


class Sess:
    """What the classifiers know of a session besides the turn: the world's rows, the status and effort of its tasks as
    the session has left them, the rows shown so far, the result handles, the turns already explained by `status`."""

    def __init__(self, session: dict, ids: Ids):
        self.ids = ids
        self.world = load_world(session["world"])
        self.task: dict[str, dict] = {}
        for t in self.world.get("tasks", []):
            if t.get("key") in ids.keys:
                self.task[ids.keys[t["key"]]["id"]] = {"status": world_status(t), "effort": t.get("effort"),
                                                       "priority": t.get("priority")}
        self.names: dict[str, list[tuple[str, list[str]]]] = {}
        self.rows: dict[str, tuple[str, dict]] = {}  # world key -> (kind, the world's row)
        self.name_of: dict[str, tuple[str, list[str], str]] = {}  # vault id -> (name, nicknames, kind)
        for section, kind in SECTION_KIND.items():
            for row in self.world.get(section, []):
                aliases = [row["nickname"]] if row.get("nickname") else []
                self.names.setdefault(kind, []).append((row["name"], aliases))
                if row.get("key"):
                    self.rows[row["key"]] = (kind, row)
                    if row["key"] in ids.keys:
                        self.name_of[ids.keys[row["key"]]["id"]] = (row["name"], aliases, kind)
        self.names.setdefault("person", []).append((self.world["me"], []))
        self.shown: dict[str, int] = {}  # vault id -> the first turn that listed, offered or wrote it
        self.written: dict[str, int] = {}  # vault id -> the last turn that wrote it (created, edited, starred, ...)
        self.gold_rows: dict[int, list[str]] = {}  # turn -> the keys of the rows its gold answers (first rows accept)
        self.handles: dict[str, tuple[int, list[str]]] = {}  # "@n" -> (turn, ids of the rows it holds)
        self.status_turns: dict[int, dict] = {}  # turn -> what the status rule changed in its result
        self.due_turns: set[int] = set()  # turns explained by `due-active`: a follow-up that reads their result follows
        self.dated_kinds: dict[int, str | None] = {}  # turn -> the task or event it read or wrote (`kindless`, K1)
        self.balances: dict[int, tuple[str | None, list[dict]]] = {}  # turn -> (person, values) of a person's balance (K2)

    def in_progress(self) -> list[str]:
        return [vid for vid, t in self.task.items() if t.get("status") == "in_progress"]

    def prev_dated_kind(self, turn: int) -> str | None:
        """The task or event that the latest turn before `turn` that touched one read or wrote (K1)."""
        return next((k for t in range(turn - 1, -1, -1) if (k := self.dated_kinds.get(t))), None)

    def named_in(self, vid: str, message: str) -> bool:
        """The message names the row: all the words of its name (or of its nickname), or for a person the first name."""
        if vid not in self.name_of:
            return False
        name, aliases, kind = self.name_of[vid]
        said = words(message, True)
        if any(w and w <= said for w in (words(n, True) for n in [name, *aliases])):
            return True
        first = re.findall(r"[^\W_]+", fold(name))
        return kind == "person" and bool(first) and first[0] in said and len(first[0]) > 2

    def after_turn(self, turn: int, steps: list[dict]) -> None:
        """Take the turn's writes and listings into the state the next turn is looked at in."""
        for step in steps:
            eff = (step.get("response") or {}).get("effect") or {}
            for row in (eff.get("diff") or {}).get("rows") or []:
                if row.get("kind") != "task":
                    continue
                state = self.task.setdefault(row["id"], {})
                for name, (_old, new) in (row.get("fields") or {}).items():
                    if name in ("status", "effort", "priority"):
                        state[name] = new
            answer = eff.get("answer") or {}
            listed = [r["id"] for r in answer.get("rows") or eff.get("rows") or []]
            touched = [r["id"] for r in (eff.get("ask") or {}).get("options") or [] if "id" in r]  # offered by an ask
            touched += [r["id"] for r in (eff.get("diff") or {}).get("rows") or []]  # acted on
            for vid in listed + touched:
                self.shown.setdefault(vid, turn)
            for row in (eff.get("diff") or {}).get("rows") or []:
                self.written[row["id"]] = turn
            handle = eff.get("result") or answer.get("result")
            if handle:
                self.handles[handle] = (turn, listed)


@dataclass
class Cx:
    """One turn as the classifiers see it: the message, the reference calls as sent, the run, the effect."""

    sess: Sess
    turn: int
    user: str
    ref: list[dict]
    steps: list[dict]
    eff: dict
    old: list[dict] = field(default_factory=list)  # the accepts of the gold on file for the turn
    calls: list[dict] = field(init=False)
    final: int | None = field(init=False)

    def __post_init__(self) -> None:
        calls = [(s.get("response") or {}).get("call") or {} for s in self.steps]
        self.calls = [{"tool": c.get("tool"), "args": c.get("args") or {}} for c in calls]
        self.final = next((i for i, s in enumerate(self.steps) if (s.get("response") or {}).get("ends_turn")), None)

    @property
    def ids(self) -> Ids:
        return self.sess.ids

    @property
    def verbs(self) -> set[str]:
        return {c["args"].get("verb") for c in self.calls if c.get("tool") == "act" and c["args"].get("verb")}

    @property
    def last(self) -> dict:
        """The effect of the step that ended the turn."""
        return {} if self.final is None else (self.steps[self.final].get("response") or {}).get("effect") or {}

    @property
    def composed(self) -> bool:
        """The turn ended in an ask or a decline the runtime wrote itself (`effect.composed`): an `act` the vault
        refused, a write over the cap. Without the mark: the last call is not the call that ends a turn that way."""
        if self.final is None or self.last.get("tool") not in ("ask", "decline"):
            return False
        return bool(self.last.get("composed")) or self.calls[self.final].get("tool") not in ("ask", "decline")

    @property
    def ask_completed(self) -> bool:
        """The runtime completed the options of the final ask from its own candidates (D-1044-9)."""
        if self.final is None:
            return False
        eff = self.last
        if (eff.get("ask") or {}).get("completed"):
            return True
        sent = self.calls[self.final].get("args", {}).get("options") or []
        sent_n = {int(m) for o in sent for m in re.findall(r"\d+", str(o))}
        got_n = {o.get("n") for o in (eff.get("ask") or {}).get("options") or []}
        return bool(sent_n) and sent_n < got_n

    @property
    def matched_line(self) -> bool:
        return any(MATCHED.search((s.get("response") or {}).get("text") or "") for s in self.steps)

    @property
    def consumed(self) -> list[str]:
        """The result handles (`@n`) the calls of the turn read."""
        out: list[str] = []

        def walk(v) -> None:
            if isinstance(v, str) and re.fullmatch(r"@\d+", v):
                out.append(v)
            elif isinstance(v, dict):
                for x in v.values():
                    walk(x)
            elif isinstance(v, list):
                for x in v:
                    walk(x)

        for c in self.calls:
            walk(c.get("args", {}))
        return out

    @property
    def terminal_handle(self) -> str | None:
        return self.last.get("result") or (self.last.get("answer") or {}).get("result")

    def readings(self) -> list[str]:
        """`pos` / `neg` for every status condition of the calls that the rule of D-1044-7 reads."""
        out = []
        for c in self.calls:
            where = c.get("args", {}).get("where")
            if isinstance(where, str):
                out += [r for op, values in status_clauses(where) if (r := open_reading(op, values))]
        return out

    def limited(self) -> bool:
        return any(c.get("args", {}).get("limit") for c in self.calls)

    def chain(self) -> list[int]:
        """The earlier turns, already explained by `status`, whose result this turn reads through a handle."""
        found = {src[0] for h in self.consumed if (src := self.sess.handles.get(h)) and src[0] < self.turn}
        return sorted(u for u in found if u in self.sess.status_turns)


# ---------------------------------------------------------------------------------------------
# Deriving an accept from an effect
# ---------------------------------------------------------------------------------------------


def _created_fields(steps: list[dict]) -> dict[str, list[str]]:
    """The fields each created row was given in the call that created it (the `field: value` lines of `args`)."""
    out: dict[str, list[str]] = {}
    for step in steps:
        resp = step.get("response") or {}
        text = (resp.get("call") or {}).get("args", {}).get("args")
        names = re.findall(r"^\s*([A-Za-z_][\w ]*?)\s*:", text, re.M) if isinstance(text, str) else []
        for row in (resp.get("effect") or {}).get("created") or []:
            out[row["id"]] = names
    return out


def _spec_updated(row: dict, key: str, old_specs: list[dict], notes: dict) -> dict:
    """An `updated` row spec from the effect; the matchers of the old spec of that row survive where they still match."""
    fields_new = {f: v[1] for f, v in row["fields"].items()}
    updates = [s for s in old_specs if "key" in s and s.get("change", "updated") == "updated"]
    spec_old = next((s for s in updates if s["key"] == key), None)
    old_fields = (spec_old or {}).get("fields", {})
    # no spec of this row: the fields come in the order a sibling spec with the same fields has them
    order = old_fields or next((s["fields"] for s in updates if set(s.get("fields", {})) == set(fields_new)), {})
    out: dict = {}
    for f in [f for f in order if f in fields_new] + [f for f in fields_new if f not in order]:
        if f in old_fields and match_value(old_fields[f], fields_new[f]):
            out[f] = copy.deepcopy(old_fields[f])
        else:
            out[f] = copy.deepcopy(gold.ANY) if f in VOLATILE else literal(fields_new[f])
    if spec_old and out == old_fields:
        notes["carried"].append(f"row spec {key}")
    return {"key": key, "change": "updated", "fields": out}


def _spec_created(row: dict, old_specs: list[dict], used: set[int], called: dict[str, list[str]], notes: dict) -> dict:
    """A `new` row spec: the old spec of that kind when it still matches the created row, else the fields the call
    set."""
    fields_new = {f: v[1] for f, v in row["fields"].items()}
    for i, spec in enumerate(old_specs):
        if (i not in used and spec.get("new") == row["kind"]
                and all(f in fields_new and match_value(v, fields_new[f]) for f, v in spec.get("fields", {}).items())):
            used.add(i)
            notes["carried"].append(f"row spec new {row['kind']}")
            return copy.deepcopy(spec)
    named = [f for f in called.get(row["id"], []) if f in fields_new] or [f for f in ("name",) if f in fields_new]
    notes["derived"].append(f"new {row['kind']} spec from the fields the call set: {named}")
    return {"new": row["kind"], "fields": {f: literal(fields_new[f]) for f in named}}


def _spec_ids(specs: list[dict]) -> dict[tuple, dict]:
    """Row specs by identity: (row, key, change), or (new, kind, n) for the n-th creation of a kind."""
    count: dict[str, int] = {}
    out = {}
    for s in specs:
        if "new" in s:
            n = count.get(s["new"], 0)
            count[s["new"]] = n + 1
            out["new", s["new"], n] = s
        else:
            out["row", s["key"], s.get("change", "updated")] = s
    return out


SECRET_FIELDS = ("password", "code", "card_number", "cvv", "notes")  # the fields of a locker item `reveal` can show


def reveal_checks(eff: dict, world: dict, ids: Ids) -> list[dict]:
    """The `reveal` checks of a gold that has none: the locker item whose secret is in the text the run revealed."""
    out = []
    for row in world.get("locker", []):
        if row.get("key") not in ids.keys:
            continue
        for fld in SECRET_FIELDS:
            value = row.get(fld)
            if isinstance(value, str) and value and any(value in t for t in eff["revealed"]):
                out.append({"key": row["key"], "contains": value})
                break
    return out


def derive_diff(eff: dict, ids: Ids, old: list[dict], steps: list[dict], notes: dict, as_diff: bool,
                world: dict | None = None) -> dict:
    """The net vault change of the turn as a gold diff, and for an accept of type diff the checks that go with it
    (`already`, `reveal`, `settle`): the old ones that the run still satisfies, and the settlement the run made."""
    merged = eff["diff"]
    old_specs = [r for a in old for r in a.get("diff", {}).get("rows", [])]
    created_ids = {r["id"] for r in merged["rows"] if r["change"] == "created"}
    called = _created_fields(steps)
    settled: dict[str, str] = {}
    if as_diff and eff["settle_texts"]:
        for r in merged["rows"]:
            bal = (r["fields"].get("balance") or [None, None])[1]
            if (r["kind"] == "person" and set(r["fields"]) == {"balance"} and isinstance(bal, dict)
                    and abs(float(bal.get("amount") or 0)) < 0.005 and r["id"] in ids.person_names):
                settled[r["id"]] = ids.person_names[r["id"]]
    rows, used = [], set()
    for r in merged["rows"]:
        if r["id"] in settled:
            continue
        if r["change"] == "created":
            rows.append(_spec_created(r, old_specs, used, called, notes))
            continue
        key = key_of(ids, r["id"])
        if key is None:
            raise Underivable(f"the turn changed {r['kind']} {r['id'][:8]}, which has no world key")
        if r["change"] == "updated":
            rows.append(_spec_updated(r, key, old_specs, notes))
        else:
            rows.append({"key": key, "change": r["change"]})
    position = {ident: i for i, ident in enumerate(_spec_ids(old_specs))}
    idents = list(_spec_ids(rows))
    rows = [rows[i] for i in sorted(range(len(rows)), key=lambda i: position.get(idents[i], len(position)))]
    links = []
    for link in merged["links"]:
        ends = ["new" if x in created_ids else key_of(ids, x) for x in (link["from"], link["to"])]
        if None in ends:
            raise Underivable("the turn linked a row that has no world key")
        links.append({"change": link["change"], "from": ends[0], "to": ends[1]})
    out: dict = {"diff": {"rows": rows, "links": links}}
    if not as_diff:
        return out
    old_already = [k for a in old for k in a.get("already", [])]
    already = [k for k in old_already if id_of(ids, k) in eff["already"]]
    if already:
        notes["carried"].append("already " + ", ".join(already))
    elif not rows and not links:
        already = [k for k in (key_of(ids, v) for v in eff["already"]) if k]
        if already:
            notes["derived"].append("already " + ", ".join(already))
    notes["dropped"] += [f"already {k}" for k in old_already if k not in already]
    if already:
        out["already"] = already
    old_reveal = [r for a in old for r in a.get("reveal", [])]
    reveal = [r for r in old_reveal if any(r["contains"] in t for t in eff["revealed"])]
    if reveal:
        notes["carried"].append("reveal " + ", ".join(r["key"] for r in reveal))
        out["reveal"] = reveal
    if not reveal and eff["revealed"] and world is not None:  # the old gold asked for none: read it off the world
        reveal = reveal_checks(eff, world, ids)
        if reveal:
            notes["derived"].append("reveal " + ", ".join(r["key"] for r in reveal))
            out["reveal"] = reveal
    notes["dropped"] += [f"reveal {r['key']}" for r in old_reveal if r not in reveal]
    old_settle = [s for a in old for s in a.get("settle", [])]
    names = list(settled.values())
    kept = [s for s in old_settle if s["name"] in names and any(s["name"] in t for t in eff["settle_texts"])
            and (not s.get("amount") or any(s["amount"] in t for t in eff["settle_texts"]))]
    if kept:
        notes["carried"].append("settle " + ", ".join(s["name"] for s in kept))
    settle = kept + [{"name": n} for n in names if n not in {s["name"] for s in kept}]
    if settle:
        out["settle"] = settle
    notes["dropped"] += [f"settle {s['name']}" for s in old_settle if s not in kept]
    return out


def derive_accept(eff: dict, ids: Ids, old: list[dict], steps: list[dict],
                  world: dict | None = None) -> tuple[dict, dict]:
    """The terminal effect of a turn as one accepted effect in the vocabulary of gold.py, and what was carried over
    from the old accepts, derived beside them or dropped: {"carried", "derived", "dropped"}. Raises Underivable.

    The accept is the one `score.judge_accept` passes against `eff`; `regen_turn` re-scores it before it is used."""
    notes: dict = {"carried": [], "derived": [], "dropped": []}
    kind = eff["kind"]
    if kind not in KINDS_WITH_EFFECT:
        raise Underivable(f"the reference run ended in {kind}")
    if kind != "act" and eff["revealed"]:
        raise Underivable("the reference run revealed a secret under a gold that asks for none")
    if kind == "rows":
        keys = [key_of(ids, v) for v in eff["rows"]]
        if None in keys:
            gone = [v[:8] for v, k in zip(eff["rows"], keys) if k is None]
            raise Underivable(f"the answer lists rows with no world key: {gone[:3]}")
        old_rows = next((a for a in old if a["type"] == "rows"), None)
        # the old gold decides whether the order counts; without a rows accept the runtime's own flag does
        ordered = bool(old_rows.get("order")) if old_rows else bool(eff.get("ordered"))
        if not ordered and old_rows:
            keys = [k for k in old_rows["rows"] if k in keys] + [k for k in keys if k not in old_rows["rows"]]
        accept: dict = {"type": "rows", "rows": keys}
        if ordered:
            accept["order"] = True
    elif kind == "value":
        value = eff["value"]
        if value.get("groups"):
            accept = {"type": "value", "groups": {str(g["key"]): [{"amount": num(v["amount"]), "unit": v.get("unit")}
                                                                  for v in g["values"]] for g in value["groups"]}}
        else:
            accept = {"type": "value", "values": [{"amount": num(v["amount"]), "unit": v.get("unit")}
                                                  for v in value.get("values") or []]}
    elif kind == "ask":
        keys = [key_of(ids, v) for v in eff["options"]]
        if None in keys:
            notes["dropped"].append(f"{keys.count(None)} option(s) with no world key")
        accept = {"type": "ask", "candidates": [k for k in keys if k]}
    elif kind == "decline":
        accept = {"type": "decline", "reasons": [eff["reason"]]}
    else:
        accept = {"type": "diff"}
    parts = derive_diff(eff, ids, old, steps, notes, as_diff=kind == "act", world=world)
    if kind == "act":
        accept.update({k: parts[k] for k in ("diff", "already", "reveal", "settle") if k in parts})
    elif parts["diff"]["rows"] or parts["diff"]["links"]:
        accept["diff"] = parts["diff"]
    if any("diff" in a for a in old if a["type"] != "diff") and "diff" not in accept:
        notes["dropped"].append("also (the write of the old gold does not happen in the run)")
    return accept, notes


# ---------------------------------------------------------------------------------------------
# What differs between two accepts
# ---------------------------------------------------------------------------------------------


def compare(old: dict, new: dict) -> dict:
    """The difference between two accepts of one type: {"added", "removed", "changed", "extra"}. `extra` is true when
    anything differs besides the added and removed items (an order that counts, an `also` diff, a check)."""
    t = new["type"]
    out: dict = {"type": t, "added": [], "removed": [], "changed": [], "extra": False}
    also = canon_diff(old.get("diff")) != canon_diff(new.get("diff"))
    if t == "rows":
        o, n = old["rows"], new["rows"]
        out["added"] = [k for k in n if k not in o]
        out["removed"] = [k for k in o if k not in n]
        order = bool(old.get("order")) != bool(new.get("order")) or (
            bool(old.get("order")) and [k for k in o if k in n] != [k for k in n if k in o])
        out["extra"] = order or also
    elif t == "value":
        out["changed"] = [] if canon(old.get("values") or old.get("groups")) == canon(
            new.get("values") or new.get("groups")) else ["value"]
        out["extra"] = ("groups" in old) != ("groups" in new) or also
    elif t == "diff":
        oi, ni = _spec_ids(old["diff"]["rows"]), _spec_ids(new["diff"]["rows"])
        out["added"] = [i for i in ni if i not in oi]
        out["removed"] = [i for i in oi if i not in ni]
        out["changed"] = [i for i in oi if i in ni and canon(oi[i]) != canon(ni[i])]
        links = [sorted(canon(x) for x in a["diff"]["links"]) for a in (old, new)]
        out["extra"] = links[0] != links[1] or any(canon(old.get(k)) != canon(new.get(k))
                                                   for k in ("already", "settle", "reveal"))
    elif t == "ask":
        out["added"] = [k for k in new["candidates"] if k not in old["candidates"]]
        out["removed"] = [k for k in old["candidates"] if k not in new["candidates"]]
        out["extra"] = also
    else:
        out["changed"] = [] if sorted(old["reasons"]) == sorted(new["reasons"]) else ["reason"]
    return out


# ---------------------------------------------------------------------------------------------
# The conventions: each says why a change is the runtime's, or returns None
# ---------------------------------------------------------------------------------------------


def _capped_write(accept: dict, cx: Cx) -> int:
    """The rows an accept writes when the cap stops that write: any rows when the effect records the cap, else more
    than ROW_CAP."""
    wrote = len(accept.get("diff", {}).get("rows", []))
    if cx.last.get("bulk") and wrote:
        return wrote
    return wrote if accept["type"] in ("diff", "rows", "value") and wrote > ROW_CAP else 0


UNBOUNDED = re.compile(r"\b(?:all|every|everything)\b", re.I)
BOUNDED = re.compile(r"\b(?:just|only|finished|done|completed|cancelled|canceled|old|overdue|trashed|duplicates?|empty|"
                     r"expired)\b", re.I)


def bounded_wording(text: str) -> bool:
    """The request names its own bound ("just the finished ones", "all the old ones"); only "all my tasks", "everything"
    with no such word is unbounded by wording."""
    return bool(BOUNDED.search(text)) or not UNBOUNDED.search(text)


def explain_bulk_cap(old: dict, new: dict, cx: Cx) -> str | None:
    """The old gold wrote more rows than ROW_CAP; the runtime now asks, with the count, instead of writing. A decline
    for unbounded destruction that stands beside such a write accept is the same reading of the message, and the cap
    answers it the same way."""
    if new["type"] != "ask" or not cx.composed:
        return None
    bulk = cx.last.get("bulk")
    wrote = _capped_write(old, cx)
    if wrote and bulk:  # the effect says so: `bulk` is what the runtime records when it asks about a write over the cap
        return (f"the old gold wrote {wrote} rows; the write named {bulk.get('count')}, over the cap of "
                f"{bulk.get('cap')}; the runtime asks")
    if wrote:
        return f"the old gold wrote {wrote} rows, over the cap of {ROW_CAP}; the runtime asks"
    if bulk and old["type"] == "decline" and "unbounded_destruction" in old["reasons"]:
        beside = max((_capped_write(a, cx) for a in cx.old if a is not old), default=0)
        if beside:
            return (f"decline unbounded_destruction beside a write of {beside} rows; the write named "
                    f"{bulk.get('count')}, over the cap of {bulk.get('cap')}; the runtime asks")
        if bounded_wording(cx.user):  # D-1044-13 (G13): "just the finished ones" is a bounded request, not "all my tasks"
            return (f"decline unbounded_destruction for a request the message bounds; the write named "
                    f"{bulk.get('count')}, over the cap of {bulk.get('cap')}; the runtime asks")
    return None


LEGACY_REFUSALS = ("restore", "delete", "remove_from")  # the verbs whose refusals D-1044-10 and D-1044-12 composed


def explain_refusal(old: dict, new: dict, cx: Cx) -> str | None:
    """A refusal of the vault ends as a decline the runtime writes (a restore past the window), or as an ask a
    confirmation can answer (a delete of a folder that is not empty); the old gold encoded the `error:` the runtime
    used to return. The effect names the refusal (`effect.refusal`); older runs name only the verb."""
    refusal = cx.last.get("refusal")
    verbs = sorted(cx.verbs & {"restore", "delete", "remove_from"})
    if new["type"] not in ("ask", "decline") or not cx.composed or cx.last.get("bulk") or not (refusal or verbs):
        return None
    verb = (refusal or {}).get("verb") or (verbs[0] if verbs else None)
    if verb not in LEGACY_REFUSALS:
        return None  # a refusal of another verb is `composed-refusal` (D-1044-13)
    what = new["reasons"][0] if new["type"] == "decline" else f"{len(new['candidates'])} option(s)"
    check = f" ({refusal['predicate']})" if (refusal or {}).get("predicate") else ""
    return (f"{verb} refused by the vault{check}; the runtime ends in {new['type']} ({what}); "
            f"the old gold was {old['type']}")


def explain_ask_options(old: dict, new: dict, cx: Cx) -> str | None:
    """Old and new are asks over the same selector, and the new one lists every candidate."""
    if old["type"] != "ask" or new["type"] != "ask" or not cx.ask_completed:
        return None
    o, n = set(old["candidates"]), set(new["candidates"])
    if not o < n or compare(old, new)["extra"]:
        return None
    return f"options completed from the candidates: {len(o)} named, {len(n)} offered"


def explain_name_match(old: dict, new: dict, cx: Cx) -> str | None:
    """A reference call names a row by a nickname or an accented spelling, the old runtime dead-ended there and the
    reference went on through `search`; the new runtime resolves it and the turn ends at that call."""
    if cx.matched_line:
        return "a by-name call was matched to its one live fit (the reply says so)"
    if cx.final is None or len(cx.steps) >= len(cx.ref):
        return None
    for call in cx.calls[: cx.final + 1]:
        args = call.get("args", {})
        name = args.get("name")
        if call.get("tool") not in ("find", "answer", "compute", "act") or not isinstance(name, str):
            continue
        plain, folded = words(name, False), words(name, True)
        kinds = [args["kind"]] if isinstance(args.get("kind"), str) else list(cx.sess.names)
        rows = [(kind, row_name, aliases) for kind in kinds for row_name, aliases in cx.sess.names.get(kind, [])]
        if not plain or any(plain <= words(row_name, False) for _kind, row_name, _aliases in rows):
            continue  # the old matcher found a row: no dead end for the new one to resolve
        for kind, row_name, aliases in rows:
            if folded <= words(row_name, True) or any(folded <= words(a, True) for a in aliases):
                return (f'name="{name}" reaches {kind} "{row_name}" by accent fold or nickname; the old matcher '
                        f"found no row, and the reference chain ends at once")
    return None


def _rows_ok(cx: Cx, added: list[str], removed: list[str], chain: list[int]) -> str | None:
    """Rows added to a selection are tasks in progress; rows taken from it are pushed out by a limit, are in_progress
    under `!= open`, or left a result that a follow-up reads."""
    inprog = set(cx.sess.in_progress())
    if (not added and not removed) or not all(a in inprog for a in added):
        return None
    readings = set(cx.readings())
    if removed:
        displaced = cx.limited() and len(removed) == len(added)  # a limit lets out as many rows as the new ones take
        dropped = "neg" in readings and not added and all(r in inprog for r in removed)
        upstream = set().union(*(cx.sess.status_turns[u]["removed"] for u in chain)) if chain else set()
        if not (displaced or dropped or (chain and set(removed) <= upstream)):
            return None
    elif "pos" not in readings and not chain:
        return None
    shown = added or removed
    return f"rows {'added' if added else 'removed'}: " + ", ".join(f"{key_of(cx.ids, v)} (in_progress)" for v in shown)


def _subset_sums(values: list[float]) -> set[float]:
    return {round(sum(c), 6) for n in range(1, len(values) + 1) for c in itertools.combinations(values, n)}


def _over(sess: Sess, op: str | None, fld: str | None, rows: list[str]) -> float | None:
    """`op` over the `fld` of rows (the tasks of the world, as the session left them)."""
    if op == "count":
        return float(len(rows))
    vals = [float(sess.task[r].get(fld) or 0) for r in rows if r in sess.task] if fld else []
    if op == "sum":
        return sum(vals)
    return {"max": max, "min": min}[op](vals) if op in ("max", "min") and vals else None


def _moves(sess: Sess, op: str, fld: str | None, ov: float | None, nv: float, cand: list[str], pos: bool,
           neg: bool) -> bool:
    """A count, sum, max or min goes from `ov` to `nv` (`ov` None: the group is new) by some of the tasks `cand` in
    progress joining (`pos`) or leaving (`neg`) the selection."""
    efforts = [float(sess.task[r].get(fld) or 0) for r in cand] if fld else []
    if op == "count":
        delta = nv - (ov or 0)
        return (pos and 0 < delta <= len(cand)) or (neg and -len(cand) <= delta < 0)
    if not fld:
        return False
    if op == "sum":
        delta = nv - (ov or 0)
        sums = _subset_sums(efforts)
        return (pos and round(delta, 6) in sums) or (neg and round(-delta, 6) in sums)
    if not any(abs(nv - e) < 0.005 for e in efforts):
        return False
    if ov is None:
        return pos
    grows = (op == "max") == (nv > ov)
    return (pos and grows) or (neg and not grows)


def _grouped(sess: Sess, group: str | None, key: str) -> list[str]:
    """The tasks in progress that belong to a group of a count or sum by `group` (a priority, or none)."""
    return [r for r in sess.in_progress()
            if group is None or ("none" if sess.task[r].get(group) is None else str(sess.task[r][group])) == key]


def _value_ok(old: dict, new: dict, cx: Cx, chain: list[int]) -> str | None:
    """A count, sum, max or min (also by priority) that moves by tasks in progress; with a limit, a top N that now holds
    one; a follow-up that reads the rows of a result the rule changed is the same op over those rows."""
    value = cx.eff.get("value") or {}
    op, fld, group = value.get("op"), value.get("field"), value.get("group")
    if op not in ("count", "sum", "max", "min") or ("groups" in old) != ("groups" in new):
        return None
    readings, sess = set(cx.readings()), cx.sess
    pos, neg = "pos" in readings, "neg" in readings
    if "groups" in old:
        if group != "priority":
            return None
        before = {str(k): float(v[0]["amount"]) for k, v in old["groups"].items() if len(v) == 1}
        after = {str(k): float(v[0]["amount"]) for k, v in new["groups"].items() if len(v) == 1}
        moved = [k for k in sorted(set(before) | set(after)) if before.get(k) != after.get(k)]
        if not moved or any(k not in after for k in moved):
            return None
        if all(_moves(sess, op, fld, before.get(k), after[k], _grouped(sess, group, k), pos, neg) for k in moved):
            return f"{op}{' of ' + fld if fld else ''} by {group} moves in the groups {', '.join(moved)} by tasks in progress"
        return None
    if len(old["values"]) != 1 or len(new["values"]) != 1:
        return None
    ov, nv = float(old["values"][0]["amount"]), float(new["values"][0]["amount"])
    if abs(nv - ov) < 0.005:
        return None
    if chain and not readings:
        for h in cx.consumed:
            if h not in sess.handles or sess.handles[h][0] not in chain:
                continue
            turn, listed = sess.handles[h]
            src = sess.status_turns[turn]
            new_over = _over(sess, op, fld, listed)
            old_over = _over(sess, op, fld, src["old_rows"]) if src.get("handle") == h and src.get("old_rows") else None
            if new_over is not None and abs(new_over - nv) < 0.005 and (old_over is None or abs(old_over - ov) < 0.005):
                return f"{op} over the rows of {h}, a result the rule changed: {num(ov)} to {num(nv)}"
        return None
    if cx.limited():  # a top N: the value follows the rows the status read lists, which now hold a task in progress
        inprog = set(sess.in_progress())
        listed = [r["id"] for st in cx.steps for r in ((st.get("response") or {}).get("effect") or {}).get("rows") or []
                  if r["id"] in inprog]
        if listed and pos:
            names = ", ".join(str(key_of(cx.ids, v)) for v in dict.fromkeys(listed))
            return f"{op} over a top N that now holds {names} (in_progress): {num(ov)} to {num(nv)}"
        return None
    if _moves(sess, op, fld, ov, nv, sess.in_progress(), pos, neg):
        return f"{op}{' of ' + fld if fld else ''} moves {num(ov)} to {num(nv)} by tasks in progress"
    return None


def _diff_ok(cx: Cx, cmp: dict) -> str | None:
    """A write that names its rows through a result reaches tasks in progress that the selection now holds."""
    if cmp["removed"] or cmp["changed"] or not cmp["added"] or any(i[0] == "new" for i in cmp["added"]):
        return None
    got = {r["id"]: r for r in cx.eff["diff"]["rows"]}
    inprog = set(cx.sess.in_progress())
    keys = [i[1] for i in cmp["added"]]
    for key in keys:
        vid = id_of(cx.ids, key)
        status = ((got.get(vid) or {}).get("fields") or {}).get("status")
        if vid is None or not (status[0] == "in_progress" if status else vid in inprog):
            return None
    return "the write reaches tasks in progress through its selection: " + ", ".join(keys)


def explain_status(old: dict, new: dict, cx: Cx) -> str | None:
    """D-1044-7: `status = open` selects open and in_progress. The rows added to (or taken from) the selection are
    exactly tasks in progress, in a listing, a count, a sum, a max or min, or the diff of a write that names its rows
    through a result; a follow-up that reads such a result changes with it."""
    chain = cx.chain()
    if (not cx.readings() and not chain) or old["type"] != new["type"]:
        return None
    cmp = compare(old, new)
    if cmp["extra"]:
        return None
    if new["type"] == "rows":
        added, removed = ids_of(cx.ids, cmp["added"]), ids_of(cx.ids, cmp["removed"])
        return None if added is None or removed is None else _rows_ok(cx, added, removed, chain)
    if new["type"] == "value":
        return _value_ok(old, new, cx, chain)
    if new["type"] == "diff":
        return _diff_ok(cx, cmp)
    return None


def explain_what_else(old: dict, new: dict, cx: Cx) -> str | None:
    """D-1044-8 and D-1044-13 (G2): a message that asks what else, what other, what remains, "besides X" or "the one
    after" leaves out the rows already shown, offered by an ask or written earlier, and the rows it names itself."""
    if not WHAT_ELSE.search(cx.user) or old["type"] != "rows" or new["type"] != "rows":
        return None
    cmp = compare(old, new)
    if cmp["extra"] or cmp["added"] or not cmp["removed"]:
        return None
    gone = ids_of(cx.ids, cmp["removed"])
    if gone is None:
        return None
    shown = [v for v in gone if v in cx.sess.shown and cx.sess.shown[v] < cx.turn]
    named = [v for v in gone if v not in shown and cx.sess.named_in(v, cx.user)]
    if len(shown) + len(named) != len(gone):
        return None
    parts = []
    if shown:
        parts.append("rows left out because they were shown earlier: " + ", ".join(
            k for k, v in zip(cmp["removed"], gone) if v in shown))
    if named:
        parts.append("rows left out because the message names them: " + ", ".join(
            k for k, v in zip(cmp["removed"], gone) if v in named))
    return "; ".join(parts)


def _says(cx: Cx, note: str) -> bool:
    """A step of the turn carries the reply note of a convention of the runtime."""
    return any(note in ((s.get("response") or {}).get("text") or "") for s in cx.steps)


def _gone_ok(old: dict, new: dict, cx: Cx, ends: bool) -> str | None:
    """The shared reading of container readouts and status words: the rows left out are tasks that are completed or
    cancelled (a count, a sum or a max moves the way leaving rows out moves it; a grouping by status loses exactly the
    groups of those statuses). `ends` is true for a result that may end empty."""
    if old["type"] != new["type"]:
        return None
    cmp = compare(old, new)
    if cmp["extra"]:
        return None
    if new["type"] == "rows":
        gone = ids_of(cx.ids, cmp["removed"])
        if gone is None or cmp["added"] or not gone:
            return None
        if not all(cx.sess.task.get(v, {}).get("status") in DONE for v in gone):
            return None
        return "rows left out, completed or cancelled: " + ", ".join(cmp["removed"]) + (
            " (none are left)" if ends and not new["rows"] else "")
    if new["type"] != "value":
        return None
    value = cx.eff.get("value") or {}
    op, group = value.get("op"), value.get("group")
    if "groups" in old:
        before = {str(k): v for k, v in old["groups"].items()}
        after = {str(k): v for k, v in new["groups"].items()}
        dropped = sorted(set(before) - set(after))
        if group == "status" and dropped and set(after) <= set(before) and all(k in DONE for k in dropped) and all(
                before[k] == after[k] for k in after):
            return f"{op} by status loses the groups {', '.join(dropped)}"
        return None
    if len(old["values"]) != 1 or len(new["values"]) != 1:
        return None
    ov, nv = float(old["values"][0]["amount"]), float(new["values"][0]["amount"])
    moved = {"count": nv < ov, "sum": nv < ov, "max": nv <= ov, "min": nv >= ov}.get(op)
    if not moved or abs(nv - ov) < 0.005:
        return None
    return f"{op} over the active rows moves {num(ov)} to {num(nv)}"


def explain_container(old: dict, new: dict, cx: Cx) -> str | None:
    """A read, count or sum over the tasks of a list or a parent task, with no status condition, selects the active
    rows (open and in_progress); the reply says so."""
    return _gone_ok(old, new, cx, True) if _says(cx, NOTE_CONTAINER) else None


def explain_status_words(old: dict, new: dict, cx: Cx) -> str | None:
    """A readout whose message says open, left, remaining, still or overdue gets `status = open` from the runtime."""
    return _gone_ok(old, new, cx, True) if _says(cx, NOTE_STATUS_WORDS) else None


def explain_next(old: dict, new: dict, cx: Cx) -> str | None:
    """A listing over a dated kind whose message says "next" reads as the nearest upcoming one: order date asc, limit 1,
    from today on. The rows left are the nearest one (or none, when none is dated from today on)."""
    if not _says(cx, NOTE_NEXT) or old["type"] != "rows" or new["type"] != "rows":
        return None
    cmp = compare(old, new)
    if cmp["added"] or not cmp["removed"] or len(new["rows"]) > 1:
        return None
    return "the message says next: " + (f"{new['rows'][0]} is the nearest of {len(old['rows'])}" if new["rows"]
                                         else "no row is dated from today on")


def explain_last_one(old: dict, new: dict, cx: Cx) -> str | None:
    """A listing whose message says "last one" reads as the latest past one: order date desc, limit 1, up to today."""
    if not _says(cx, NOTE_LAST) or old["type"] != "rows" or new["type"] != "rows" or len(new["rows"]) != 1:
        return None
    return f"the message says last one: {new['rows'][0]} is the latest of {len(old['rows'])}"


DUE = re.compile(r"\bdue\b", re.I)
EVERY = re.compile(r"\b(?:all|everything|done|completed|finished|cancelled|canceled|already|history)\b", re.I)


def explain_due_active(old: dict, new: dict, cx: Cx) -> str | None:
    """D-1044-13 (G23): "what's due <span>" lists the tasks dated in the span that are still to do (open and in
    progress), as every status word does. The reference call says `status = open`, and the rows left out are
    completed or cancelled. "all", "done", "finished" in the message override."""
    direct = bool(DUE.search(cx.user)) and not EVERY.search(cx.user) and "pos" in cx.readings()
    through = any(src[0] in cx.sess.due_turns and src[0] < cx.turn
                  for h in cx.consumed if (src := cx.sess.handles.get(h)))  # a follow-up reads the result of a due turn
    if not (direct or through):
        return None
    why = _gone_ok(old, new, cx, True)
    return (f"the message says due: {why}" if direct else f"it reads the result of a due turn: {why}") if why else None


def explain_focus_wins(old: dict, new: dict, cx: Cx) -> str | None:
    """D-1044-13 (G11): right after the user starred, edited or created a row, a following message about "the" row of
    that kind with one such row in focus is about that row; the runtime does not ask which. The old gold was an ask whose
    candidates include the row written in the turn before, and the new effect touches that row and no other."""
    if old["type"] != "ask" or new["type"] not in ("diff", "rows") or len(old["candidates"]) < 2:
        return None
    targets = set(new.get("rows") or []) if new["type"] == "rows" else set()
    targets |= {r["key"] for r in new.get("diff", {}).get("rows", []) if "key" in r}
    targets |= {r["key"] for r in new.get("reveal", [])}
    if len(targets) != 1:
        return None
    (key,) = targets
    if key not in old["candidates"]:
        return None
    last = cx.turn - 1
    if cx.sess.written.get(id_of(cx.ids, key)) != last:
        return None
    if any(cx.sess.written.get(id_of(cx.ids, c)) == last for c in old["candidates"] if c != key):
        return None  # two of the candidates were just written: nothing is in focus alone
    return f"{key} is the one of the {len(old['candidates'])} candidates written in the turn before; focus wins over an ask"


def _composed_plain(cx: Cx) -> bool:
    """The turn ended in an ask or a decline the runtime wrote itself, for no vault refusal and no cap."""
    return cx.composed and not cx.last.get("bulk") and not cx.last.get("refusal")


def explain_composed_ask(old: dict, new: dict, cx: Cx) -> str | None:
    """D-1044-13 (M1, the model never asks first): an ambiguous write, or a name that matches nothing but near spellings,
    ends in the ask the runtime composes from its own candidates. The old gold was the model's ask over other
    candidates, or a decline not_found."""
    if new["type"] != "ask" or not _composed_plain(cx):
        return None
    if not (old["type"] == "ask" or (old["type"] == "decline" and set(old["reasons"]) <= {"not_found"})):
        return None
    return f"the runtime composed the ask ({len(new['candidates'])} option(s)); the old gold was {old['type']}"


def explain_composed_decline(old: dict, new: dict, cx: Cx) -> str | None:
    """D-1044-13 (M1): a write that matches nothing, or a target the vault cannot take, ends in the decline the runtime
    composes (not_found, out_of_scope). The old gold was the model's ask or another decline."""
    if new["type"] != "decline" or not _composed_plain(cx) or old["type"] not in ("ask", "decline"):
        return None
    return f"the runtime composed the decline ({new['reasons'][0]}); the old gold was {old['type']}"


def explain_composed_refusal(old: dict, new: dict, cx: Cx) -> str | None:
    """D-1044-13 (M1, D-1044-10 extended): a vault refusal of any verb other than restore, delete and remove_from ends
    in the ask or the decline the runtime composes from the refusal's own rows (a time conflict, an unsettled balance,
    a person into an event)."""
    refusal = cx.last.get("refusal")
    if not refusal or new["type"] not in ("ask", "decline") or not cx.composed or cx.last.get("bulk"):
        return None
    check = f" ({refusal['predicate']})" if refusal.get("predicate") else ""
    return (f"{refusal.get('verb') or 'the verb'} refused by the vault{check}; the runtime ends in {new['type']}; "
            f"the old gold was {old['type']}")


# the messaging request of G1: "text jordan", "tell sunita i said hi", "email the landlord"
MESSAGING = re.compile(r"^\s*(?:(?:please|pls|hey|ok|okay|and|then|now)[, ]+)*(?:(?:can|could) you )?"
                       r"(?:text|e-?mail|message|dm|whatsapp|ping|tell|send (?:a |an )?(?:text|message|e-?mail)(?: to)?)"
                       r"\s+(?!me\b|us\b|my\b|the vault\b)", re.I)
LOGGING = re.compile(r"\blog\b|\bnote that i\b|\bremind\b", re.I)


def is_messaging(text: str) -> bool:
    """A request to send someone a message: out of scope unless the user says to log it (G1)."""
    return bool(MESSAGING.search(text)) and not LOGGING.search(text)


def explain_messaging(old: dict, new: dict, cx: Cx) -> str | None:
    """D-1044-13 (G1): "text X", "tell X I said hi", "email X" is out of scope, whoever X is: the vault holds no channel
    to send on. The old gold asked which X, or wrote a log."""
    if not is_messaging(cx.user) or new["type"] != "decline" or new["reasons"] != ["out_of_scope"]:
        return None
    return "a request to message someone is out of scope" if old["type"] in ("ask", "diff") else None


SUPERLATIVE = re.compile(r"\b(?:longest|shortest|biggest|smallest|largest|how long|how big)\b", re.I)
STILL_IN = re.compile(r"\bstill\s+(?:in|on)\b", re.I)
CONTAINERS = ("folder", "album", "list", "notebook", "group")


def _single_rows(a: dict) -> bool:
    return a["type"] == "rows" and len(a["rows"]) == 1 and "diff" not in a


def _single_value(a: dict) -> bool:
    return a["type"] == "value" and len(a.get("values") or []) == 1 and "diff" not in a


def _one_group(a: dict) -> bool:
    return a["type"] == "value" and len(a.get("groups") or {}) == 1 and "diff" not in a


def explain_superlative(old: dict, new: dict, cx: Cx) -> str | None:
    """D-1044-13 (G3): "longest job", "biggest of those", "how long will it take" accept the row (ordered, one) or its
    value; the two shapes are both the answer. Widening: the old accept stays beside the new one."""
    if not SUPERLATIVE.search(cx.user):
        return None
    if (_single_rows(old) and _single_value(new)) or (_single_value(old) and _single_rows(new)):
        return "the message asks for a superlative: the row and its value are both answers"
    return None


def explain_group_or_value(old: dict, new: dict, cx: Cx) -> str | None:
    """D-1044-13 (G4): a grouped count whose result has one group is the plain value, and the plain value is that group.
    Widening."""
    for a, b in ((old, new), (new, old)):
        if _one_group(a) and _single_value(b) and value_list_match(next(iter(a["groups"].values())), b["values"]):
            return "a grouped count with one group is the plain value"
    return None


def explain_container_or_row(old: dict, new: dict, cx: Cx) -> str | None:
    """D-1044-13 (G8): "is X still in the Y folder" accepts the row or its container as the answer. Widening."""
    if not STILL_IN.search(cx.user) or not (_single_rows(old) and _single_rows(new)):
        return None
    kinds = [cx.sess.rows.get(a["rows"][0], (None,))[0] for a in (old, new)]
    if sorted(k in CONTAINERS for k in kinds) == [False, True]:
        return "the row and the container that holds it are both answers to a question of membership"
    return None


# B6 (D-1044-15): "who owes me", "who do i owe", "who's that to" about debts
WHO_DEBT = re.compile(r"(?:^|[,;.?!]|\b(?:and|so|ok|okay|then|now|hey)\b)\s*who\s*(?:"
                      r"(?:\s+still)?\s+owes?\b|\s+(?:do|did|should|must|will)\s+(?:i|we)\s+owe\b|"
                      r"(?:'s|s|\s+is)\s+(?:that|it|this|they)\s+(?:to|from)\b)", re.I)  # a clause that starts with it


def _kinds_of(a: dict, sess: Sess) -> set[str | None]:
    return {sess.rows.get(k, (None,))[0] for k in a["rows"]} if a["type"] == "rows" and a["rows"] else set()


def _people_of_debts(a: dict, sess: Sess) -> list[str]:
    """The people the debt rows of a rows accept link to, in the order of the rows, each once."""
    out: list[str] = []
    for key in a["rows"]:
        person = sess.rows[key][1].get("person")
        if person in sess.rows and person not in out:
            out.append(person)
    return out


def explain_debt_or_person(old: dict, new: dict, cx: Cx) -> str | None:
    """D-1044-15 (B6): "who owes me", "who do i owe" and "who's that to" about debts accept the open debt rows and the
    people those debts link to; the two shapes are both the answer. Widening: the old accept stays beside the new one."""
    if not WHO_DEBT.search(cx.user):
        return None
    for debts, people in ((old, new), (new, old)):
        if (_kinds_of(debts, cx.sess) == {"debt"} and _kinds_of(people, cx.sess) == {"person"}
                and sorted(_people_of_debts(debts, cx.sess)) == sorted(people["rows"])):
            return "the message asks who a debt is with: the debt rows and the people they link to are both answers"
    return None


def widen_debt_or_person(gold: list[dict], user: str, ref: list[dict], sess: Sess, ti: int,
                         steps: list[dict]) -> list[dict]:
    if not WHO_DEBT.search(user):
        return []
    return [{**copy.deepcopy(a), "rows": _people_of_debts(a, sess)} for a in gold
            if _kinds_of(a, sess) == {"debt"} and _people_of_debts(a, sess)]


# ---------------------------------------------------------------------------------------------
# K1 to K4: what the blind gold audit settled (D-1044-13, refined)
# ---------------------------------------------------------------------------------------------

DATED = ("task", "event")  # the kinds a read of a span of time can mean

# K1, the kind of a kind-less read. The message names no kind and nothing that implies one (due, open, done, pinned, and
# "on my plate", which is what is to do)
KIND_NOUN = re.compile(
    r"\b(?:tasks?|to-?dos?|chores?|errands?|jobs?|reminders?|events?|appointments?|meetings?|calls?|calendar|schedule|"
    r"agenda|diary|people|persons?|contacts?|friends?|groups?|notes?|documents?|docs?|files?|photos?|pictures?|pics?|"
    r"albums?|debts?|loans?|owe[sd]?|lockers?|passwords?|logins?|notebooks?|folders?|lists?|items?)\b", re.I)
KIND_IMPLIED = re.compile(
    r"\b(?:due|overdue|open|done|completed?|finish(?:ed)?|progress|priority|effort|cancel(?:led)?|pinned|jotted|wrote|"
    r"written|trashed|deleted|pending|unfinished|plate)\b", re.I)
KINDLESS_HEAD = re.compile(
    r"^\s*(?:(?:and|so|ok|okay|now|hm+|wait|no)[, ]+)*(?:what(?:'s| is|s| else| other| more)|anything|any)\b", re.I)
LEFT_CUE = re.compile(r"\b(?:left|remaining)\b", re.I)
ON_CUE = re.compile(r"\b(?:what(?:'s|s| is)?|anything|any)\s+(?:(?:still|else|is)\s+)*on\b", re.I)
CONTINUES = re.compile(r"\b(?:else|other|others|more|also|too|another|again)\b", re.I)


# B3b (D-1044-15): a question about a span of time with no "on", no "left" and no task word is the calendar too
_DAY = r"(?:mon|tues|wednes|thurs|fri|satur|sun)day"
_ORDINAL = (r"\d{1,2}(?:st|nd|rd|th)|(?:twenty|thirty)[- ]?(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)|"
            r"first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|"
            r"fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth")
_MONTH = (r"jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|"
          r"oct(?:ober)?|nov(?:ember)?|dec(?:ember)?")
SPAN_WORD = re.compile(
    rf"\b(?:today|tonight|tomorrow|tmrw|yesterday|weekends?|{_DAY}|(?:this|next|last|coming)\s+(?:week|month|morning|"
    rf"afternoon|evening)|(?:the\s+)?(?:{_ORDINAL})|(?:{_MONTH})\s+\d)\b", re.I)
# the words a bare span is made of: a fragment ("and tomorrow", "and the 14th") and "anything next weekend" are nothing else
SPAN_TOKEN = re.compile(
    rf"^(?:and|so|then|also|ok|okay|now|on|at|for|in|the|this|next|last|coming|week|weekend|weekends|month|morning|afternoon|"
    rf"evening|night|today|tonight|tomorrow|tmrw|yesterday|{_DAY}|{_ORDINAL}|{_MONTH}|\d{{1,2}}(?::\d\d)?(?:am|pm)?|"
    rf"o'?clock|noon|midnight)$", re.I)
SPAN_QUESTION = re.compile(
    r"^\s*(?:(?:and|so|ok|okay|now|hm+|wait|no)[, ]+)*(?:"
    r"what(?:\s+else)?(?:'s| is|s)\s+the\s+plan\b"
    r"|what\s+(?:does|do|will|would)\s+.+?\s+look(?:s|ing)?\s+like\b"
    r"|what(?:'s| is|s)\s+.+?\s+looking\s+like\b"
    r"|what(?:'ve|\s+have|\s+do|\s+did|\s+will)?\s+(?:i|we)\s+(?:got|have)\b)", re.I)
TASK_WORD = re.compile(r"\b(?:to\s+(?:do|buy|get|pay|bring|pick|finish|send|call|fix)|need|needs|must|should|supposed|"
                       r"have\s+to|got\s+to|behind|late|chores?)\b", re.I)


def _bare_span(text: str) -> bool:
    """The message is a span of time and nothing else (a head such as "and" or "anything" counts as part of it)."""
    tokens = [t for t in re.findall(r"[\w']+", text.lower()) if t not in ("anything", "any", "else")]
    return bool(tokens) and all(SPAN_TOKEN.match(t) for t in tokens) and bool(SPAN_WORD.search(text))


def kindless_reading(user: str, prev: str | None) -> tuple[str, str] | None:
    """K1 and B3b: the kind a read of "what's left this weekend", "what's still on today", "what's the plan for next week"
    or "and tomorrow" means when the message names none, and why: (`task` or `event`, the reason), or None when the rule
    does not apply. `prev` is the task or event the latest earlier turn read or wrote. A continuation ("anything else on",
    "what other") and "left" or "remaining" take it; as a first read "left" is a task. "what's on" names the calendar: an
    event, whatever the turn before read (a time after "on" is a day, not a list), and so does a span question with no "on",
    no "left" and no task word ("what's the plan for next week", "anything next weekend", "what does next week look like",
    "what've i got next monday"). A fragment, a bare span after "and" or "so" ("and tomorrow", "and the 14th"), keeps the
    kind of the turn before (and is no reading without one). Messages with a kind noun or a word that implies the kind
    (due, open, done, pinned) are not kind-less."""
    if KIND_NOUN.search(user) or KIND_IMPLIED.search(user):
        return None
    if re.match(r"\s*(?:and|so|then|also)\b", user, re.I) and _bare_span(user):
        return (prev, "a fragment keeps the kind of the turn before") if prev else None
    if not KINDLESS_HEAD.match(user) and not SPAN_QUESTION.match(user):
        return None
    left, on = bool(LEFT_CUE.search(user)), bool(ON_CUE.search(user))
    span = not (left or on) and not TASK_WORD.search(user) and SPAN_WORD.search(user) and (
        SPAN_QUESTION.match(user) or (re.match(r"\s*(?:(?:and|so|ok|okay|now|hm+|wait|no)[, ]+)*(?:anything|any)\b", user, re.I)
                                      and _bare_span(user)))
    if not (left or on or span):
        return None
    more = CONTINUES.search(user)
    if more:
        return (prev, f"'{more.group(0).lower()}' goes on with the {prev}s of the turn before") if prev else (
            ("task", "a first 'left' is a task") if left else ("event", "a first 'on' is the calendar"))
    if on:
        return "event", "'on' names the calendar"
    if span:
        return "event", "a span question with no kind names the calendar"
    return (prev, f"'left' reads the {prev}s of the turn before") if prev else ("task", "a first 'left' is a task")


def kindless_kind(user: str, prev: str | None) -> str | None:
    reading = kindless_reading(user, prev)
    return reading[0] if reading else None


def _listing(core: dict) -> bool:
    """A reference read that lists tasks or events over a span of time: a kind, a `when`, and no name, container, handle,
    value or aggregate."""
    return (core.get("kind") in DATED and bool(core.get("when")) and not core.get("op")
            and not any(core.get(k) for k in ("linked_to", "within", "rows", "value", "name")))


def dated_kind(turn: dict, kind_of) -> str | None:
    """The one of `task` and `event` that a turn read or wrote (K1): the kind of its listing read, else the kind its
    reference calls name, else the kind of the rows its gold answers, offers or writes; None when it touched neither, or
    both. `kind_of(world key)` is the kind of a row of the world."""
    ref = turn.get("ref") or []
    core = _core_call(ref)
    if _listing(core):
        return core["kind"]
    kinds = {k for c in ref if (k := (c.get("args") or {}).get("kind")) in DATED}
    if not kinds:
        first = (turn.get("gold") or [{}])[0]
        written = (first.get("diff") or {}).get("rows", [])
        keys = [*(first.get("rows") or []), *(first.get("candidates") or []), *(r["key"] for r in written if "key" in r)]
        kinds = {k for k in (kind_of(x) for x in keys) if k in DATED} | {r["new"] for r in written if r.get("new") in DATED}
    return next(iter(kinds)) if len(kinds) == 1 else None


def gold_kinds(accepts: list[dict], kind_of) -> set[str]:
    """The kinds of the rows the rows-accepts of a gold answer."""
    return {k for a in accepts if a["type"] == "rows" for x in a["rows"] if (k := kind_of(x))}


def explain_kindless(old: dict, new: dict, cx: Cx) -> str | None:
    """D-1044-13 (K1): a read of "what's left this weekend" or "what's still on today" that names no kind reads the kind
    `kindless_reading` says, and the reference read (prepared with that kind, `rewrite_kindless`) lists the rows of it:
    the old gold listed rows of the other kind (an old gold with no rows says no kind, and is not this)."""
    core = _core_call(cx.ref)
    if old["type"] != "rows" or new["type"] != "rows" or not _listing(core):
        return None
    reading = kindless_reading(cx.user, cx.sess.prev_dated_kind(cx.turn))
    if reading is None or reading[0] != core["kind"]:
        return None
    seen = gold_kinds([old], lambda k: cx.sess.rows.get(k, (None,))[0])
    if not seen or reading[0] in seen:
        return None  # no old rows say another kind (an empty answer says none), or they were of that kind already
    return f"the message names no kind: {reading[1]}, so it reads {reading[0]}s"


# K3, a request broken off mid-sentence
BROKEN = re.compile(r"(?:\.\.\.|…)\s*(?:hm+|um+|uh+|er+|ah+|oh|ugh|no|nah|nope|wait|actually|sorry|just|"
                    r"never\s*mind|scratch\s+that|or\s+rather)\b", re.I)
RETRACTION = re.compile(r"\b(?:never\s*mind|forget\s+(?:it|that)|skip\s+it|kidding|scratch\s+that|leave\s+it)\b", re.I)
REQUEST = re.compile(r"^(?:(?:no|nah|nope|wait|actually|ok|okay|so|then|just|now|and|please|ugh|hm+)[, ]+)*"
                     r"(?:create|make|add|put|move|push|bump|delete|remove|trash|cancel|star|unstar|pin|unpin|tick|mark|"
                     r"set|log|file|restore|undo|edit|change|rename|reschedule|book|call|remind|show|list|find|tell|give|"
                     r"settle|pay|do|text|email)\b", re.I)


def last_request(user: str) -> str | None:
    """K3: the last complete request of a message that breaks off mid-sentence ("move the note into... hmm i don't have
    that notebook. create one called Home") and goes on, or None for a message that does not, that ends in a retraction
    ("... no wait. never mind"), or whose last words are no request. A broken-off clause is not a request: only the last
    complete one runs."""
    found = list(BROKEN.finditer(user))
    if not found:
        return None
    parts = [p.strip(" ,;:-") for p in re.split(r"[.!?]+(?:\s+|$)", user[found[-1].end():]) if p.strip(" ,;:-")]
    if not parts or RETRACTION.search(parts[-1]):
        return None
    return next((p for p in reversed(parts) if REQUEST.match(p)), None)


def _spec_set(accept: dict, key: str) -> set[str]:
    return {canon(x) for x in (accept.get("diff") or {}).get(key, [])}


def explain_broken_off(old: dict, new: dict, cx: Cx) -> str | None:
    """D-1044-13 (K3): the message breaks off mid-sentence and goes on with a request of its own, and only that request
    runs: the new diff is the old one without what the broken-off clause would have written."""
    last = last_request(cx.user)
    if last is None or old["type"] != "diff" or new["type"] != "diff":
        return None
    rows, links = (_spec_set(old, "rows"), _spec_set(new, "rows")), (_spec_set(old, "links"), _spec_set(new, "links"))
    if not (links[1] <= links[0] and rows[1] <= rows[0]) or (rows[1], links[1]) == (rows[0], links[0]):
        return None
    if any(canon(old.get(name)) != canon(new.get(name)) for name in ("already", "reveal", "settle")):
        return None
    return (f"the message breaks off and goes on with '{last}': only the last complete request runs; left out: "
            + ", ".join(sorted(rows[0] - rows[1] | links[0] - links[1]))[:160])


# K4, a bare plural is not "all". The words are the runtime's own closed list (crates/nativetools/src/ground.rs,
# `said_every_row` and `TIME_SPANS`; a test reads the source and fails when the two differ)
EVERY_ROW = ("both", "everyone")  # always say every row
EVERY_ROW_QUANTIFIERS = ("all", "every", "everything", "each", "whole", "entire")  # ... unless a stretch of time follows
TIME_SPANS = ("day", "days", "week", "weeks", "weekend", "weekends", "night", "nights", "morning", "mornings",
              "afternoon", "afternoons", "evening", "evenings", "month", "months", "year", "years")


def runtime_tokens(message: str) -> list[tuple[str, bool]]:
    """The words of a message as the runtime reads them (ground.rs `word_tokens`), each with whether it was written as a
    possessive: lower case, curly quotes straight, hyphens as spaces, the edges of a word that are not alphanumeric cut,
    a possessive 's cut."""
    out = []
    for word in message.lower().replace("’", "'").replace("‘", "'").replace("-", " ").split():
        word = word.strip("".join(c for c in set(word) if not c.isalnum()))
        possessive = word.endswith("'s")
        word = word[:-2] if possessive else word
        word = word.strip("".join(c for c in set(word) if not c.isalnum()))
        if word:
            out.append((word, possessive))
    return out


def runtime_words(message: str) -> list[str]:
    """The words of a message as the runtime reads them: `runtime_tokens` without the possessive mark."""
    return [word for word, _ in runtime_tokens(message)]


def says_every_row(message: str) -> bool:
    """Whether the message says that a write takes every row its selector fits (the runtime's `said_every_row`, with no
    trace): both, everyone, or all, every, everything, each, whole, entire not followed by a stretch of time ("every
    week", "the whole weekend")."""
    words = runtime_words(message)
    return any(w in EVERY_ROW or (w in EVERY_ROW_QUANTIFIERS and not (at + 1 < len(words) and words[at + 1] in TIME_SPANS))
               for at, w in enumerate(words))


def explain_bare_plural(old: dict, new: dict, cx: Cx) -> str | None:
    """D-1044-13 (K4, the inverse of the runtime's "all, every, each, both, everyone applies a write to every row it
    fits"): several rows fit a name that a bare plural gives ("push the mark 9 tests to friday") and nothing in the
    message says all: the turn ends in the ask over them, not in the write to every one."""
    if old["type"] != "diff" or new["type"] != "ask" or not _composed_plain(cx) or says_every_row(cx.user):
        return None
    if (cx.last.get("compose") or {}).get("family", "ambiguous_write") != "ambiguous_write":
        return None
    written = [r["key"] for r in old.get("diff", {}).get("rows", []) if "key" in r]
    if len(written) < 2 or not set(written) <= set(new["candidates"]):
        return None
    return (f"{len(written)} rows fit the name and the message says none of all, every, each, both or everyone: "
            f"the runtime asks which, it does not write to all")


# M5d and M5e, a recurring event or task is asked about. What a message may say to aim at one instance of a series is read
# from the runtime's own lists (crates/nativetools/src/act.rs `PICKED`, ground.rs `BROAD`, `SPANNING`, `DESTINATIONS`,
# `SETTERS`, `ROW_MARKERS`, `WEEKDAYS`, `WORD_LIKE`, `BEFORE_SHORT_WEEKDAY`, `MONTHS`; a test reads those sources and fails
# when one differs) and from two lists of the rule's own, which no source holds: `NOT_A_PICK` and `STATED_PRONOUNS`
PICKED = ("it", "them", "that", "this", "those", "these", "he", "she", "her", "him", "his", "they", "one", "ones", "too",
          "also", "same", "again", "both", "other", "another", "first", "second", "third", "last", "latest", "previous",
          "next", "earlier", "later", "open", "done", "finished", "paid", "old", "new", "oldest", "newest")
# PICKED words that aim at no instance of a series: the state words name what the verb filters by already ("tick off rent,
# just paid"), "too", "also", "same" and "again" repeat what was asked, and "next" is ported with them from the runtime's
# former default (which took the next instance). The rule's own, no source to agree with: `test_what_picks_nothing`
NOT_A_PICK = ("next", "open", "done", "finished", "paid", "too", "also", "same", "again")
# Pronouns that stand for the name the message itself states ("Order composite resin, push it to monday") are no pick of
# an earlier result: they point at the row the name gives. "this", "these" and the pronouns for a person still pick.
STATED_PRONOUNS = ("it", "them", "that", "those", "one", "ones")
BROAD = ("week", "weeks", "weekend", "weekends", "month", "months", "year", "years", "every", "daily", "weekly", "monthly",
         "ago", "later", "earlier", "before", "after", "since", "until", "till", "between")
SPANNING = ("through", "from", "onwards", "overdue")
DESTINATIONS = ("to", "for", "by", "it", "them", "instead", "till", "until", "til")  # a date after these is where a row goes
SETTERS = ("make", "made", "set", "mark", "put", "change", "update", "give", "have", "move", "push", "to")
ROW_MARKERS = ("dated", "from", "of", "scheduled")  # a date after these belongs to the row
WEEKDAYS = ("monday", "tuesday", "tue", "tues", "wednesday", "thursday", "thu", "thur", "thurs", "friday", "fri", "saturday",
            "sunday", "mon", "wed", "sat", "sun")
WORD_LIKE = ("mon", "wed", "sat", "sun")  # short weekdays that are also words: a weekday only after BEFORE_SHORT_WEEKDAY
BEFORE_SHORT_WEEKDAY = ("next", "this", "last", "on", "to", "by", "till", "until")
MONTHS = ("january", "jan", "february", "feb", "march", "april", "may", "june", "july", "august", "aug", "september", "sept",
          "sep", "october", "oct", "november", "nov", "december", "dec", "jul")
DAY_WORDS = ("tomorrow", "tmrw", "tmr", "tomorow", "today", "tonight", "yesterday")
WORD_ORDINALS = ("first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh",
                 "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth",
                 "twentieth", "thirtieth")
CLOCK = re.compile(r"^(?:\d{1,2}(?:[:.]\d\d)?(?:am|pm)|\d{1,2}:\d\d)$")
IN_A_SPAN = re.compile(r"\bin\s+(?:an?|half an|\d+)\s+(?:hours?|hrs?|minutes?|mins?)\b", re.I)


def _is_ordinal(word: str, after: str | None) -> bool:
    """A day of the month said as an ordinal: "14th", "fourteenth", "twenty seventh" (ground.rs `numeric_ordinal`,
    `word_ordinal`)."""
    digits = next((word[: -len(s)] for s in ("st", "nd", "rd", "th") if word.endswith(s)), None)
    if digits is not None and digits.isdigit() and 1 <= int(digits) <= 31:
        return True
    return word in WORD_ORDINALS or (word in ("twenty", "thirty") and after in WORD_ORDINALS[:9])


def _is_weekday(word: str, prev: str | None) -> bool:
    """A weekday word; the short ones that are also words ("sat", "sun") only after one of BEFORE_SHORT_WEEKDAY."""
    return (word in WEEKDAYS and word not in WORD_LIKE) or (word in WORD_LIKE and prev in BEFORE_SHORT_WEEKDAY)


def _number_like(word: str | None) -> bool:
    """Whether a word can start a day of the month ("11", "3rd", "third", "twenty": ground.rs `is_number_like`)."""
    return bool(word) and (word[0].isdigit() or _is_ordinal(word, None) or word in ("twenty", "thirty"))


def message_states(message: str, name: str) -> bool:
    """Whether the message states a name: every word of it is a word of the message, case and accents folded, a possessive
    dropped ("Order composite resin, push it to monday" states "Order composite resin", "push it to monday" does not).
    An article is a word like any other: "Call the vet" is stated by a message that says "the"."""
    wanted = words(name, True)
    return bool(wanted) and wanted <= words(message, True)


def _only_a_destination(tokens: list[tuple[str, bool]], start: int, end: int) -> bool:
    """Whether the date phrase tokens[start..=end] only says where a write goes ("to friday", "back to 8pm": ground.rs
    `role_at`, a Dest), and so picks no row. A possessive ("friday's call"), a "one" after it, a "due", a marker of the row
    ("from", "of", "dated") or no marker at all picks the row."""
    if tokens[end][1] or (end + 1 < len(tokens) and tokens[end + 1][0] in ("one", "ones")):
        return False
    at = start
    while at > 0 and tokens[at - 1][0] in ("the", "a", "an"):
        at -= 1

    def word(back: int) -> str | None:
        return tokens[at - back][0] if at - back >= 0 else None

    if word(1) == "due":
        return any(word(back) in SETTERS for back in (2, 3))
    if word(1) == "on" and word(2) == "instead":
        return True
    return word(1) in DESTINATIONS


def _picks(message: str, name: str | None) -> bool:
    """Whether a word of the message picks one row of a series: a word of PICKED that is not one of NOT_A_PICK, or a plural
    weekday ("tuesdays"). When the message states the series' `name`, the STATED_PRONOUNS point at that name and pick
    nothing, except a "one" or "ones" after a word that picks or narrows ("the next one", "the open one"): that one is
    chosen among the others."""
    spoken = re.findall(r"[^\W_]+", fold(message))
    stated = name is not None and message_states(message, name)
    for at, word in enumerate(spoken):
        if word.endswith("s") and _is_weekday(word[:-1], None):
            return True
        if word not in PICKED or word in NOT_A_PICK:
            continue
        before = spoken[at - 1] if at else None
        chosen = word in ("one", "ones") and before in PICKED and before not in STATED_PRONOUNS
        if not (stated and word in STATED_PRONOUNS) or chosen:
            return True
    return False


def says_which(message: str, name: str | None = None) -> bool:
    """Whether the message says which row of a series it means: an all-word, a word that picks one (it, that, one, the
    other, the first, the last, the old one; a plural weekday: `_picks`, which reads `name`, the series' name), or a date,
    an ordinal, a month or a stretch of time that does not only say where a write goes. Read so that it may say yes where
    the runtime reads no (the date words are ground.rs's): a yes keeps `series-ask` from explaining away a write the
    person aimed at one instance. Clocks count as aiming unless they follow a word that gives a destination ("to 8pm")."""
    if says_every_row(message) or _picks(message, name):
        return True
    if IN_A_SPAN.search(message):
        return True
    tokens = runtime_tokens(message)
    for at, (word, _) in enumerate(tokens):
        prev = tokens[at - 1][0] if at else None
        after = tokens[at + 1][0] if at + 1 < len(tokens) else None
        if word in BROAD or word in SPANNING or _is_ordinal(word, after):
            return True
        if word in MONTHS and (word != "may" or _number_like(after)):
            return True
        if _is_weekday(word, prev) or word in DAY_WORDS:
            start = at - 1 if _is_weekday(word, prev) and prev in ("next", "this") else at
            if not _only_a_destination(tokens, start, at):
                return True
        elif CLOCK.match(word) or (word.isdigit() and after in ("am", "pm")):
            if not _only_a_destination(tokens, at, at):
                return True
    return False


def _series_key(key: str, sess: Sess) -> tuple[str, str] | None:
    """(kind, folded name) of the dated row a world key is, which is what a series shares; None for a row of any other
    kind (a person, a note ... has no instances of a name)."""
    row = sess.rows.get(key)
    return (row[0], fold(row[1]["name"])) if row and row[0] in DATED else None


def series_of(keys: list[str], sess: Sess) -> tuple[str, str] | None:
    """(kind, name) of the recurring series that `keys` are: two or more live rows of one dated kind (events or tasks, a
    completed task among them) with one name (folded); else None. An event and a task of one name are no series."""
    found = {_series_key(k, sess) for k in keys}
    if len(keys) < 2 or len(found) != 1 or None in found:
        return None
    kind, row = sess.rows[keys[0]]
    return kind, row["name"]


# the sessions whose gold asks over a series, as the evidence of the ruling (val: events and a task, test: tasks)
SERIES_EVIDENCE = ("a recurring {kind} named without a date is asked about; the gold asks over a series (val B-E093, "
                   "D-E127, D-E128, T12-085, T12-092 for events, T23-108 for tasks; test T03-106, T12-111 for tasks) "
                   "[{count} {kind}s called {name!r}]")


def explain_series_ask(old: dict, new: dict, cx: Cx) -> str | None:
    """D-1044-13 (M5d, M5e): a write by the name of a recurring series (two or more live events, or two or more live tasks,
    of one name), with nothing in the message that says which (no date, ordinal, word that picks one or word for all; a
    pronoun for the name the message states picks nothing), ends in the runtime's ask over the series, and an old gold
    that wrote to one of its instances (the next upcoming, the one open) is replaced by it."""
    if old["type"] != "diff" or new["type"] != "ask" or not _composed_plain(cx):
        return None
    if (cx.last.get("compose") or {}).get("family", "ambiguous_write") != "ambiguous_write":
        return None
    series = series_of(new["candidates"], cx.sess)
    spec = old.get("diff") or {}
    written = [r.get("key") for r in spec.get("rows", [])]
    if series is None or len(written) != 1 or None in written:
        return None  # several written rows are `bare-plural`'s: the write to one instance is this rule's
    if spec.get("links") or any(old.get(k) for k in ("settle", "reveal")):
        return None  # a write that does more than change the one instance
    if _series_key(written[0], cx.sess) != _series_key(new["candidates"][0], cx.sess) or says_which(cx.user, series[1]):
        return None  # a row outside the series was written, or the message aims at one instance
    return SERIES_EVIDENCE.format(kind=series[0], count=len(new["candidates"]), name=series[1])


# K2, a balance narrowed to one group ("just the household one") after a person's balance
NARROWING = re.compile(r"\b(?:just|only|specifically|in particular)\b", re.I)


def _ref_key(text) -> str | None:
    m = re.fullmatch(r"\s*\$(\w+)\s*", str(text or ""))
    return m.group(1) if m else None


def _row_of(args: dict, sess: Sess, kind: str, handles: tuple[str, ...]) -> str | None:
    """The world key of the row of `kind` that a reference call is about: a `$key` in one of `handles`, else the one
    row whose name (or nickname) holds all the words of the call's `name`."""
    for fld in handles:
        key = _ref_key(args.get(fld))
        if key and sess.rows.get(key, (None,))[0] == kind:
            return key
    name = args.get("name")
    if not isinstance(name, str) or not words(name, True):
        return None
    hits = [k for k, (rk, row) in sess.rows.items() if rk == kind
            and any(words(name, True) <= words(n, True) for n in (row.get("name"), row.get("nickname")) if n)]
    return hits[0] if len(hits) == 1 else None


def person_balance(turn: dict, accepts: list[dict], sess: Sess) -> tuple[str | None, list[dict]] | None:
    """(the person, the values) of a turn that answered a person's balance, from its reference read and the first values
    accept of its gold; None for any other turn."""
    core = _core_call(turn.get("ref") or [])
    values = next((a["values"] for a in accepts if a["type"] == "value" and "values" in a), None)
    if core.get("op") != "balance" or core.get("kind") == "group" or not values:
        return None
    person = _row_of(core, sess, "person", ("rows", "linked_to"))
    return (person, copy.deepcopy(values)) if person else None


def narrowed_part(user: str, core: dict, sess: Sess, ti: int) -> tuple[str, float] | None:
    """K2: for a balance of one group of a person right after that person's balance, with a word that narrows ("just the
    household one", "in the climbing group specifically"): (the currency of the group, the person's part of the balance
    in that currency, from the values the turn before answered). None when the turn is not such a narrowing."""
    if core.get("op") != "balance" or core.get("kind") != "group" or not NARROWING.search(user):
        return None
    person, group = _ref_key(core.get("linked_to")), _row_of(core, sess, "group", ("rows",))
    before = sess.balances.get(ti - 1)
    if not person or not group or not before or before[0] != person:
        return None
    currency = sess.rows[group][1].get("currency") or sess.world.get("currency")
    part = [v for v in before[1] if v.get("unit") == currency]
    return (currency, float(part[0]["amount"])) if len(part) == 1 else None


def widen_narrowed_balance(gold: list[dict], user: str, ref: list[dict], sess: Sess, ti: int,
                           steps: list[dict]) -> list[dict]:
    """D-1044-13 (K2): the balance of a group narrowed from a person's balance is the group's net of that person
    (positive = the group owes them) or the person's own part of the balance in the group's currency (positive = they owe
    me): both are answers. The reference read is the first; the alternative is the part in the values of the turn
    before."""
    part = narrowed_part(user, _core_call(ref), sess, ti)
    if part is None or not any(_single_value(a) for a in gold):
        return []
    return [{"type": "value", "values": [{"amount": num(part[1]), "unit": part[0]}]}]


def explain_narrowed_balance(old: dict, new: dict, cx: Cx) -> str | None:
    """D-1044-13 (K2): of the two values, the group's net and the person's own part in the group's currency, one is the
    old gold and the other the run's: both are answers (a widening)."""
    part = narrowed_part(cx.user, _core_call(cx.ref), cx.sess, cx.turn)
    if part is None or not (_single_value(old) and _single_value(new)):
        return None

    def own(a: dict) -> bool:
        v = a["values"][0]
        return v.get("unit") == part[0] and abs(float(v["amount"]) - part[1]) < 0.005

    if own(old) == own(new):
        return None
    return (f"a balance narrowed to one group is the group's net or the person's part of the balance in {part[0]} "
            f"({num(part[1])}): both are answers")


# ---------------------------------------------------------------------------------------------
# Widening: an alternative accept derived from the gold, the reference calls and the world
# ---------------------------------------------------------------------------------------------


def _core_call(ref: list[dict]) -> dict:
    """The read of a reference sequence that the gold answers: the last answer, find or compute that does not just hand
    on a value."""
    for c in reversed(ref or []):
        if c.get("tool") in ("answer", "find", "compute") and not (c.get("args") or {}).get("value"):
            return c.get("args") or {}
    return {}


def _field_value(sess: Sess, key: str, fld: str) -> float | None:
    """A number of a row of the world as the session left it (a task's effort and priority follow its writes)."""
    entry = sess.rows.get(key)
    if not entry:
        return None
    vid = sess.ids.keys.get(key, {}).get("id")
    value = (sess.task.get(vid) or {}).get(fld) if entry[0] == "task" else None
    value = entry[1].get(fld) if value is None else value
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _selection(args: dict, sess: Sess, ti: int) -> list[str]:
    """The world keys a reference read selects through `rows` or `within`: `$key` handles, or the rows the gold of the
    turn before answers (`@prev`)."""
    src = args.get("rows") or args.get("within")
    text = ", ".join(src) if isinstance(src, list) else str(src or "")
    keys = re.findall(r"\$(\w+)", text)
    if not keys and "@prev" in text:
        keys = sess.gold_rows.get(ti - 1, [])
    return [k for k in keys if k in sess.rows]


def widen_superlative(gold: list[dict], user: str, ref: list[dict], sess: Sess, ti: int,
                      steps: list[dict]) -> list[dict]:
    if not SUPERLATIVE.search(user):
        return []
    args, out = _core_call(ref), []
    for a in gold:
        if _single_rows(a):
            m = re.fullmatch(r"\s*(\w+)\s+(?:asc|desc)\s*", str(args.get("order") or ""))
            value = _field_value(sess, a["rows"][0], m.group(1)) if m and str(args.get("limit")) == "1" else None
            if value is not None:
                unit = (sess.rows[a["rows"][0]][1].get("currency") or sess.world.get("currency")
                        if m.group(1) == "amount" else None)
                out.append({"type": "value", "values": [{"amount": num(value), "unit": unit}]})
        elif _single_value(a) and args.get("op") in ("max", "min", "sum") and args.get("field"):
            keys = _selection(args, sess, ti)
            amount = float(a["values"][0]["amount"])
            if args["op"] == "sum":
                hit = keys if len(keys) == 1 else []
            else:
                hit = [k for k in keys if (v := _field_value(sess, k, args["field"])) is not None
                       and abs(v - amount) < 0.005]
            if hit:
                out.append({"type": "rows", "rows": hit})
    return out


def widen_group_or_value(gold: list[dict], user: str, ref: list[dict], sess: Sess, ti: int,
                         steps: list[dict]) -> list[dict]:
    return [{"type": "value", "values": copy.deepcopy(next(iter(a["groups"].values())))} for a in gold if _one_group(a)]


def widen_container_or_row(gold: list[dict], user: str, ref: list[dict], sess: Sess, ti: int,
                           steps: list[dict]) -> list[dict]:
    if not STILL_IN.search(user):
        return []
    m = re.fullmatch(r"\s*\$(\w+)\s*", str(_core_call(ref).get("linked_to") or ""))
    if not m or sess.rows.get(m.group(1), (None,))[0] not in CONTAINERS:
        return []
    return [{"type": "rows", "rows": [m.group(1)]} for a in gold
            if _single_rows(a) and not a.get("order") and a["rows"][0] != m.group(1)]


WIDENERS = {"superlative": widen_superlative, "group-or-value": widen_group_or_value,
            "container-or-row": widen_container_or_row, "debt-or-person": widen_debt_or_person,
            "narrowed-balance": widen_narrowed_balance}


def widen_gold(gold: list[dict], user: str, ref: list[dict], sess: Sess, ti: int,
               steps: list[dict] | None = None) -> tuple[list[dict], list[str], list[str]]:
    """The gold with the alternatives the widening conventions add: (accepts, the conventions that added one, why).
    A widener derives its alternatives from the gold, the reference calls, the world and, for `composed-answer`, the
    steps of the run (`steps`, what the runtime answered to the reads of the turn). It returns accepts, or
    (accept, note) pairs whose note says where the alternative came from. Idempotent: an alternative already there
    is not added twice."""
    out, labels, why = list(gold), [], []
    have = {canon_accept(a) for a in out}
    for name in WIDENING:
        added, notes = [], []
        for extra in WIDENERS[name](gold, user, ref, sess, ti, steps or []):
            accept, note = extra if isinstance(extra, tuple) else (extra, "")
            if canon_accept(accept) not in have:
                have.add(canon_accept(accept))
                added.append(accept)
                notes.append(note)
        if added:
            out += added
            labels.append(name)
            why.append(f"{name}: alternative accept " + " OR ".join(
                show_accept(a) + (f" ({n})" if n else "") for a, n in zip(added, notes)))
    return out, labels, why


RULES = {"bulk-cap": explain_bulk_cap, "refusal": explain_refusal, "ask-options": explain_ask_options,
         "composed-refusal": explain_composed_refusal, "composed-ask": explain_composed_ask,
         "composed-decline": explain_composed_decline, "name-match": explain_name_match, "status": explain_status,
         "what-else": explain_what_else, "container": explain_container, "status-words": explain_status_words,
         "next": explain_next, "last-one": explain_last_one, "due-active": explain_due_active,
         "focus-wins": explain_focus_wins, "superlative": explain_superlative, "group-or-value": explain_group_or_value,
         "container-or-row": explain_container_or_row, "debt-or-person": explain_debt_or_person,
         "messaging": explain_messaging, "bare-plural": explain_bare_plural,
         "kindless": explain_kindless, "narrowed-balance": explain_narrowed_balance, "broken-off": explain_broken_off,
         "series-ask": explain_series_ask}


def explain(old: dict, new: dict, cx: Cx) -> tuple[str, str] | None:
    """The first convention that explains the change from `old` to `new`, with its evidence."""
    for name in CONVENTIONS:
        evidence = RULES[name](old, new, cx)
        if evidence:
            return name, evidence
    return None


# ---------------------------------------------------------------------------------------------
# A turn, a session
# ---------------------------------------------------------------------------------------------


def _labels(names: list[str]) -> str:
    return "+".join(c for c in CONVENTIONS if c in names)


def regen_turn(gt: dict, steps: list[dict], sess: Sess, ti: int) -> dict:
    """One turn, looked at in the state the session has left `sess` in: {"gold": the accepts to use, "changed",
    "held" (explained by a report-only convention: the gold stays), "convention", "was_failing", "evidence",
    "new_gold", "carried", "dropped", "note", "effect"}.

    The widening conventions (WIDENING) add their alternatives to the gold on file before the run is judged and to the
    gold derived from the run after it. A turn left UNEXPLAINED or held keeps the gold on file, alternatives and all."""
    ref = gt.get("ref") or []
    wide, added, why = widen_gold(gt["gold"], gt["user"], ref, sess, ti, steps)
    res = _regen_turn({**gt, "gold": wide} if added else gt, steps, sess, ti)
    if res["convention"] == UNEXPLAINED or res["held"]:
        return {**res, "gold": gt["gold"], "changed": False}
    final, more, why2 = widen_gold(res["gold"], gt["user"], ref, sess, ti, steps)
    if not (added or more or res["changed"]):
        return res
    names = [c for c in (res["convention"] or "").split("+") if c] + added + more
    return {**res, "gold": final, "changed": True, "new_gold": final, "convention": _labels(names),
            "evidence": "; ".join(dict.fromkeys(x for x in [res["evidence"], *why, *why2] if x))}


def _regen_turn(gt: dict, steps: list[dict], sess: Sess, ti: int) -> dict:
    """`regen_turn` for a gold that already holds the alternatives of the widening conventions."""
    ids = sess.ids
    eff = turn_effect(steps)
    old = gt["gold"]
    judged = [judge_accept(a, eff, ids)[0] for a in old] if steps else [False] * len(old)
    failing = not any(judged)
    out = {"gold": old, "changed": False, "held": False, "convention": None, "was_failing": failing, "evidence": "",
           "new_gold": None, "carried": [], "dropped": [], "note": "", "effect": eff}
    if not steps:
        if failing:
            out.update(convention=UNEXPLAINED, note="the reference run has no steps for this turn")
        return out
    cx = Cx(sess, ti, gt["user"], gt.get("ref") or [], steps, eff, old)
    ran, want = [c.get("tool") for c in cx.calls], [c.get("tool") for c in cx.ref]
    if ran != want[: len(ran)]:  # a run file of other reference calls (or a reference that ran out): no gold from it
        if failing:
            out.update(convention=UNEXPLAINED, note=f"the run does not follow the reference calls of the turn: it "
                       f"called {ran}, the reference is {want}")
        return out
    try:
        new, notes = derive_accept(eff, ids, old, steps, sess.world)
        try:
            proof = judge_accept(new, eff, ids)
        except (KeyError, ValueError) as error:
            raise Underivable(f"the derived accept cannot be judged: {error!r}") from error
        if not proof[0]:
            raise Underivable("the derived accept fails its own run: " + "; ".join(proof[1])[:200])
    except Underivable as error:
        if failing:
            out.update(convention=UNEXPLAINED, note=f"underivable: {error}")
        return out
    if failing:
        why = [explain(a, new, cx) for a in old]
        out.update(new_gold=[new], carried=notes["carried"], dropped=notes["dropped"])
        if None in why:
            n = why.index(None)
            out.update(convention=UNEXPLAINED, note=f"no convention explains the change from accept {n + 1} "
                       f"({old[n]['type']}) to the derived {new['type']}")
            return out
        labels = [w[0] for w in why]
        out.update(convention="+".join(c for c in CONVENTIONS if c in labels),
                   evidence="; ".join(dict.fromkeys(w[1] for w in why)))
        if any(c in REPORT_ONLY for c in labels):
            out.update(held=True, note="report only, the gold stays: the derived effect may not answer the question "
                       "(the reference calls dead-end on purpose); repair the reference calls at the source")
        elif all(c in WIDENING for c in labels):  # a widening convention keeps the old accepts beside the new one
            out.update(gold=old + [new], changed=True, new_gold=old + [new])
        else:
            out.update(gold=[new], changed=True)
        return out
    # The run passes the gold. Tighten it only where a convention says the gold is a superseded reading.
    keep, labels, evidence = [], [], []
    for accept, passes in zip(old, judged):
        if passes and (why := explain_ask_options(accept, new, cx)):
            labels.append("ask-options")
            evidence.append(why)
            keep += [new] if new not in keep else []
        elif not passes and (why := explain_status(accept, new, cx)):
            labels.append("status")
            evidence.append("alternative dropped, the reading before D-1044-7: " + why)
        else:
            keep.append(accept)
    if labels:
        out.update(gold=keep, changed=True, new_gold=keep, convention="+".join(c for c in CONVENTIONS if c in labels),
                   evidence="; ".join(dict.fromkeys(evidence)), carried=notes["carried"], dropped=notes["dropped"])
    return out


def _status_record(gt: dict, res: dict, ids: Ids, cx_handle: str | None) -> dict:
    """What a turn explained by `status` leaves for the follow-ups that read its result."""
    old_rows = next((a["rows"] for a in gt["gold"] if a["type"] == "rows"), None)
    old_ids = ids_of(ids, old_rows) if old_rows is not None else None
    new_ids = res["effect"].get("rows")
    removed = set(old_ids or []) - set(new_ids or [])
    return {"removed": removed, "handle": cx_handle, "old_rows": old_ids}


def regen_session(session: dict, record: dict) -> tuple[dict, list[dict]]:
    """The session with the gold of its stale turns replaced, and one change row per changed, UNEXPLAINED or held
    turn (the last two keep their gold). `record` is the session's run: {"turns": [{"steps": [...]}, ...]}."""
    ids = Ids(session["world"])
    sess = Sess(session, ids)
    turns, rows = [], []
    for ti, gt in enumerate(session["turns"]):
        steps = record["turns"][ti]["steps"] if ti < len(record.get("turns") or []) else []
        res = regen_turn(gt, steps, sess, ti)
        fix = FIXES.get((session["id"], ti + 1))
        if fix:  # D-1044-13: the turn is a hand correction. It must be in the input, and a pinned gold is never re-derived
            try:
                unfixed = apply_fix(gt, fix, session["id"], ti + 1) != gt
            except ValueError as error:
                res.update(convention=UNEXPLAINED, changed=False, note=str(error))
            else:
                if unfixed:
                    res.update(convention=UNEXPLAINED, changed=False, note=f"fix {fix['ruling']} is not in the input: "
                               "the reference run follows the unfixed calls; run `python3 regen.py refreeze`, which "
                               "prepares the sets first")
                elif pinned(session["id"], ti + 1) and res["was_failing"]:
                    res.update(convention=UNEXPLAINED, changed=False, note=f"fix {fix['ruling']} pins this gold and the "
                               "reference run fails it: " + "; ".join(
                                   judge_accept(gt["gold"][0], res["effect"], ids)[1])[:200])
        turns.append({**gt, "gold": res["gold"]} if res["changed"] else gt)
        final = res["gold"] if res["changed"] else gt["gold"]
        sess.gold_rows[ti] = next((a["rows"] for a in final if a["type"] == "rows"), [])
        sess.dated_kinds[ti] = dated_kind({"ref": gt.get("ref"), "gold": final}, lambda k: sess.rows.get(k, (None,))[0])
        sess.balances[ti] = person_balance(gt, final, sess)
        if res["convention"]:
            rows.append({"id": session["id"], "turn": ti + 1, "user": gt["user"], "convention": res["convention"],
                         "was_failing": res["was_failing"], "applied": res["changed"], "held": res["held"],
                         "old_gold": gt["gold"],
                         "new_gold": res["new_gold"], "evidence": res["evidence"], "carried": res["carried"],
                         "dropped": res["dropped"], "note": res["note"]})
        if res["changed"] and "due-active" in res["convention"].split("+"):
            sess.due_turns.add(ti)
        if res["changed"] and "status" in res["convention"].split("+"):
            cx = Cx(sess, ti, gt["user"], gt.get("ref") or [], steps, res["effect"])
            sess.status_turns[ti] = _status_record(gt, res, ids, cx.terminal_handle)
        ids.created += [r["id"] for r in res["effect"]["diff"]["rows"] if r["change"] == "created"]
        sess.after_turn(ti, steps)
    return ({**session, "turns": turns} if any(r["applied"] for r in rows) else session), rows


def composed_marks(session: dict, record: dict) -> set[tuple[int, int]]:
    """The (turn, step) of every call marked `bad` (a reference call the runtime was expected to reject) at which the
    runtime ended the turn by composing the outcome itself, a decline or an ask for a refusal of the vault (D-1044-10),
    or by applying the write to the rows it chose (`composed-apply`) when the old gold accepts what that did (M1c).
    That call is not an error any more: it is the call the model is meant to make, and the reference calls that
    followed it (the repair) are never reached."""
    out = set()
    created: list[str] = []
    ids: Ids | None = None
    for ti, turn in enumerate(record.get("turns") or []):
        gt = session["turns"][ti] if ti < len(session["turns"]) else {}
        ref = gt.get("ref") or []
        for si, step in enumerate(turn["steps"]):
            response = step.get("response") or {}
            effect = response.get("effect") or {}
            if si < len(ref) and ref[si].get("bad"):
                if effect.get("composed"):
                    out.add((ti, si))
                elif response.get("ends_turn") and composed_name(effect) == "composed-apply":
                    ids = ids or Ids(session["world"])
                    ids.created = list(created)
                    if _gold_accepts(gt, turn["steps"], ids):
                        out.add((ti, si))
        created += _created(turn["steps"])
    return out


# ---------------------------------------------------------------------------------------------
# Reference calls the runtime composed past (D-1044-11, M1)
# ---------------------------------------------------------------------------------------------
#
# The runtime ends a turn by composition at the call that causes it (an ambiguous or unmatched write, an `answer`
# whose name reaches nothing, a refusal; crates/nativetools/src/compose.rs): the reference calls after that call are
# not sent. A `find` is a lookup and never ends a turn that way (SPEC §4.8): its miss is a reply the turn goes on
# from. That is no verify problem when the outcome is of the kind the reference was heading for, an ask or a decline
# after an ambiguous write or a dead end; it is one when the reference was heading for a write, which the data would
# no longer show. `composed_ends` names each such end by its convention, `composed_problems` is what the reference
# builder's verify reports, and `composed_counts` is what a refreeze reports per set.
#
# The runtime also composes the rows of a write (M1b, M1c): it applies the write to every row the person said
# (`apply_all`), to the one near spelling of the name (`apply_near_spelling`) and to the one row of another kind the
# name names (`apply_other_kind`); the rows of one name (a series) it never picks from, they are the ask. Such an end
# is an ordinary write, a diff, that ends the turn at the call: the reference calls after it are unreached too. It is named
# `composed-apply`, and it is explained, with no change to the gold, when the old gold accepts that diff; when the
# gold is another diff (or an ask or a decline) the turn is UNEXPLAINED as for any write no convention explains,
# and that is where it is reported, never a verify problem of its own (`composed_problems`).

COMPOSED_NAMES = ("composed-ask", "composed-decline", "composed-refusal", "composed-answer", "composed-apply")
# the `compose.action` of the writes the runtime applies to rows it chose (crates/nativetools/src/act.rs `Decided`)
APPLY_ACTIONS = ("apply_all", "apply_near_spelling", "apply_other_kind")
# the ends a reference may head for, by the outcome the runtime composed instead
HEADING = {"composed-ask": ("ask", "decline"), "composed-decline": ("ask", "decline"),
           "composed-refusal": ("ask", "decline"), "composed-answer": ("answer", "ask", "decline"),
           "composed-apply": ("act",)}
HEADING_TOOL = {"ask": "ask", "decline": "decline", "answer": "answer", "find": "answer", "search": "answer",
                "compute": "answer", "open": "answer"}


def composed_name(effect: dict) -> str | None:
    """The convention that names a step ending the turn by composition (`effect.composed`): an ask, a decline, a
    refusal of the vault (`effect.refusal`, the ask or the decline), or an answer; and a write the runtime applied to
    the rows it chose (`effect.compose.action` in `APPLY_ACTIONS`, a diff, no `composed`): `composed-apply`. `None` for
    every other step, and for the cap, which `bulk-cap` names."""
    if ((effect.get("compose") or {}).get("action") in APPLY_ACTIONS and effect.get("tool") == "act"
            and effect.get("diff") is not None and not effect.get("error") and not effect.get("composed")):
        return "composed-apply"
    if not effect.get("composed") or effect.get("bulk"):
        return None
    tool = effect.get("tool")
    if tool == "answer":
        return "composed-answer"
    if tool in ("ask", "decline"):
        return "composed-refusal" if effect.get("refusal") else f"composed-{tool}"
    return None


def reference_heading(ref: list[dict]) -> str:
    """The end a reference sequence was heading for: `ask`, `decline`, `answer` (a read or a readout) or `act` (a write,
    a create, an undo), by its last call."""
    return HEADING_TOOL.get((ref[-1].get("tool") if ref else None) or "", "act")


def _created(steps: list[dict]) -> list[str]:
    """The vault ids of the rows a turn created, in order: what `Ids.created` holds for the turns after it."""
    return [r["id"] for r in turn_effect(steps)["diff"]["rows"] if r["change"] == "created"] if steps else []


def _gold_accepts(gt: dict, steps: list[dict], ids: Ids) -> bool:
    """Whether an accept of the gold on file for the turn passes the turn the run made (`ids.created`: the rows the
    session's earlier turns created, which a gold names as `+1`, `+2`)."""
    eff = turn_effect(steps)
    for accept in gt.get("gold") or []:
        try:
            if judge_accept(accept, eff, ids)[0]:
                return True
        except (KeyError, ValueError):
            continue
    return False


def composed_ends(session: dict, record: dict) -> list[dict]:
    """One row per turn the runtime ended by composition before the reference calls ran out: {"turn", "step", "convention",
    "unreached" (the reference calls not sent), "heading", "explained"}. `explained`: the outcome is of the kind the
    reference was heading for (an ask, a decline or an answer for the composed ones); for `composed-apply`, a write
    the runtime applied to rows it chose, that the old gold accepts. A turn the composed step ended last, or that the
    reference ended itself, has no row."""
    out = []
    created: list[str] = []
    ids: Ids | None = None
    for ti, turn in enumerate(record.get("turns") or []):
        gt = session["turns"][ti] if ti < len(session["turns"]) else {}
        ref = gt.get("ref") or []
        for si, step in enumerate(turn["steps"]):
            response = step.get("response") or {}
            name = composed_name(response.get("effect") or {}) if response.get("ends_turn") else None
            if name and si + 1 < len(ref):
                heading = reference_heading(ref)
                if name == "composed-apply":
                    ids = ids or Ids(session["world"])
                    ids.created = list(created)
                    explained = _gold_accepts(gt, turn["steps"], ids)
                else:
                    explained = heading in HEADING[name]
                out.append({"turn": ti, "step": si, "convention": name, "unreached": len(ref) - si - 1,
                            "heading": heading, "explained": explained})
            if response.get("ends_turn"):
                break
        created += _created(turn["steps"])
    return out


def composed_problems(session: dict, record: dict) -> list[dict]:
    """The verify problems of the reference calls the runtime composed past: one per turn whose composed end left a
    reference that was heading for something else, in the shape of the builder's problems. Not a `composed-apply`
    end, whether or not the old gold accepts what it did: a write the gold does not accept fails the turn (the score,
    or UNEXPLAINED under `--gold-from-ref`), which is where it is reported."""
    return [{"turn": e["turn"] + 1, "user": session["turns"][e["turn"]]["user"], "problems": [
        f"reference calls {e['step'] + 2}-{e['step'] + 1 + e['unreached']} are unreached after the runtime's "
        f"{e['convention']} at call {e['step'] + 1}, but the sequence was heading for {e['heading']}"]}
        for e in composed_ends(session, record) if not e["explained"] and e["convention"] != "composed-apply"]


def composed_counts(sessions: list[dict], records: list[dict]) -> dict[str, int]:
    """Per convention, the turns of a set the runtime ended by composition, whatever the reference had left: what a
    refreeze reports per set. The records run beside the sessions, by id."""
    by_id = {r["id"]: r for r in records}
    counts = {name: 0 for name in COMPOSED_NAMES}
    for s in sessions:
        for turn in (by_id.get(s["id"]) or {}).get("turns") or []:
            for step in turn["steps"]:
                response = step.get("response") or {}
                name = composed_name(response.get("effect") or {}) if response.get("ends_turn") else None
                if name:
                    counts[name] += 1
                if response.get("ends_turn"):
                    break
    return counts


def explain_composed_answer(old: dict, new: dict, cx: Cx) -> str | None:
    """D-1044-13 (M1, an `answer` that matches nothing by name): the runtime answers the rows the name fits by word
    starts or near spelling, or answers nothing, where the old gold declined not_found or asked which row was meant.
    A widening (M1b): the old gold stays beside the answer (`widen_composed_answer` adds it before the run is judged
    when the gold is a decline not_found or an ask with no candidates; this rule explains the other olds)."""
    if cx.final is None or composed_name(cx.last) != "composed-answer" or new["type"] != "rows":
        return None
    if old["type"] not in ("ask", "decline"):
        return None
    action = (cx.last.get("compose") or {}).get("action") or "answer"
    return (f"the runtime composed the answer ({action}: {len(new['rows'])} row(s)); the old gold was {old['type']}")


def _open_gold(a: dict) -> bool:
    """A gold that says nothing was found, or nothing was meant: a decline not_found, an ask with no candidates."""
    if a["type"] == "decline":
        return bool(a.get("reasons")) and set(a["reasons"]) <= {"not_found"}
    return a["type"] == "ask" and not a.get("candidates")


def _read_miss(step: dict, ids: Ids) -> tuple[list[str], str] | None:
    """What a read by name that found nothing answered, from the step that made it: (the world keys of the rows it
    carried, the `compose.action` that names it), or None when the step is not such a read. A read by name is a `find`
    or an `answer` with a `name` and no when, where or linked_to. A `find` that missed is a plain miss, `find_miss`:
    the turn goes on, it carries no rows and a hint is not an answer (SPEC §4.8). An `answer` that missed is the
    runtime's composed answer, `answer_empty`, `answer_near_spellings`, `answer_all_fits` or `answer_trashed`, its
    rows the ones the reply carried (crates/nativetools/src/compose.rs)."""
    resp = step.get("response") or {}
    call, eff = resp.get("call") or {}, resp.get("effect") or {}
    args, compose = call.get("args") or {}, eff.get("compose") or {}
    if (call.get("tool") not in ("find", "answer") or not args.get("name") or args.get("op")
            or any(args.get(k) for k in ("when", "where", "linked_to")) or compose.get("family") != "unmatched_read"):
        return None
    if call["tool"] == "find":
        return ([], "find_miss") if compose.get("action") == "find_miss" and not eff.get("rows") else None
    if eff.get("tool") != "answer" or not eff.get("composed"):
        return None
    keys = [key_of(ids, r["id"]) for r in (eff.get("answer") or {}).get("rows") or []]
    return None if None in keys else (keys, compose.get("action") or "answer")


def widen_composed_answer(gold: list[dict], user: str, ref: list[dict], sess: Sess, ti: int,
                          steps: list[dict]) -> list[dict]:
    """D-1044-13 (M1b): a gold of `decline not_found` (or an `ask` with no candidates) for a read-only turn whose
    run holds a read by name that missed also accepts what that read answered: `rows []` for a plain miss and for the
    empty answer, the near-spelling rows an `answer` carried. The runtime says nothing was found in two ways (the
    turn goes on from a `find`, an `answer` ends it) and the model may decline, ask or answer nothing; the old gold
    stays beside the alternative. A turn with an `act` is about the write, not about the miss."""
    if not any(_open_gold(a) for a in gold):
        return []
    if any(((s.get("response") or {}).get("call") or {}).get("tool") == "act" for s in steps):
        return []
    out = []
    for s in steps:
        miss = _read_miss(s, sess.ids)
        if miss is not None:
            out.append(({"type": "rows", "rows": miss[0]}, miss[1]))
        if (s.get("response") or {}).get("ends_turn"):
            break
    return out


# the convention of the one outcome M1 composes that the three of D-1044-13 do not name (the order they are tried in);
# M1b makes it a widening: the old gold stays and the read's own answer is added beside it
CONVENTIONS = (*CONVENTIONS, "composed-answer")
RULES["composed-answer"] = explain_composed_answer
WIDENING = (*WIDENING, "composed-answer")
WIDENERS["composed-answer"] = widen_composed_answer


# ---------------------------------------------------------------------------------------------
# Before the reference run: the rewrites and the fixes (D-1044-13)
# ---------------------------------------------------------------------------------------------

# Hand corrections of the gold rulings, keyed by (session id, turn number). Val ids only: no test session was read, so
# none is fixed; a convention that changes a test turn is reported, not hand-corrected. Fields of an entry:
#   ruling  the G-number of eval/gold-rulings (docs/decisions.md D-1044-13); A1 is the gold-wrong turn of the blind gold audit
#   why     one line: what the old gold got wrong
#   expect  sha1[:8] of the message the fix was written for (a fix never lands on another turn)
#   user    the message is rewritten (the turn gets `rewritten`: what it was)
#   ref     the reference calls are replaced (the reference run follows them)
#   gold    the accepts are replaced; `add` accepts are added beside the ones on file
#   derive  the gold stays and the reference run derives it through a convention (no pin)
# A turn with `gold` or `add` is pinned: a run that fails it is UNEXPLAINED, never re-derived.
# G20 was audited and needs no fix: C-E053 t1 says +872.60 USD and t2 -872.60 USD, and both are right. `balance` of a
# person is me versus them, positive = they owe me (values.rs): Lukas owes Hana 872.60 in the Home expenses. `balance` of a
# group with a person linked is that person's net in the group, positive = the group owes them: Lukas paid 1564.50 and his
# share is 2437.10, so his net is -872.60. One debt, seen from the person and from the group.
FIXES: dict[tuple[str, int], dict] = {
    ("T03-071", 3): {
        "ruling": "G5", "expect": "f7e11a9d",
        "why": "'break those down by status' follows 'any of those high priority': the narrowed set (@2, two tasks), not "
               "the 9 of the first turn (@1)",
        "ref": [{"tool": "compute", "args": {"op": "count", "group": "status", "within": "@2"}},
                {"tool": "answer", "args": {"value": "@prev"}}],
        "gold": [{"type": "value", "groups": {"open": [{"amount": 2, "unit": None}]}}]},
    ("D-E043", 2): {
        "ruling": "G6", "expect": "81965332",
        "why": "'how many are starred' after 'how many neighbors' counts the neighbors, not everyone saved",
        "ref": [{"tool": "answer", "args": {"op": "count", "kind": "person",
                                            "where": "role = \"neighbor\" and starred = yes"}}],
        "gold": [{"type": "value", "values": [{"amount": 1, "unit": None}]}]},
    ("B-E042", 3): {
        "ruling": "G7", "expect": "9c2a1b3c",
        "why": "'we leave on the twenty second then' is a statement: an acknowledgement or an open question, no write and "
               "no read of the drive event",
        "ref": [{"tool": "ask", "args": {"question": "Got it, the 22nd. Want me to put anything on that day?"}}],
        "gold": [{"type": "ask", "candidates": []}, {"type": "diff", "diff": {"rows": [], "links": []}}]},
    ("D-E108", 3): {
        "ruling": "G9", "expect": "71cbbe93",
        "why": "'and the car registration one' after 'bring it back' carries the verb: a restore, not a read",
        "ref": [{"tool": "act", "args": {"verb": "restore", "kind": "task", "name": "renew car registration",
                                         "trashed": "true"}}],
        "gold": [{"type": "diff", "diff": {"rows": [{"key": "tk581", "change": "restored"}], "links": []}}]},
    ("D-E108", 4): {
        "ruling": "G9", "expect": "552e719d",
        "why": "the row is back since the turn before: 'that one too' restores nothing (already)",
        "ref": [{"tool": "act", "args": {"verb": "restore", "rows": "$tk581"}},
                {"tool": "answer", "args": {"rows": "$tk581"}}],
        "gold": [{"type": "diff", "diff": {"rows": [], "links": []}, "already": ["tk581"]}]},
    ("D-E106", 1): {
        "ruling": "G10", "expect": "8612789f",
        "why": "'add a note, there's an idea for the garage': the clause is the body; the turn creates the note",
        "ref": [{"tool": "act", "args": {"verb": "create", "kind": "note",
                                         "args": "name: Garage idea\nbody: there's an idea for the garage"}}],
        "gold": [{"type": "diff", "diff": {"rows": [{"new": "note", "fields": {"body": {"has": ["garage"]}}}],
                                           "links": []}}]},
    ("D-E106", 3): {
        "ruling": "G10", "expect": "4f054970",
        "why": "the note of the turn before is the second note created: +2, $c2",
        "ref": [{"tool": "act", "args": {"verb": "add_to", "rows": "$c2", "args": "to: $ideas_nb"}}],
        "gold": [{"type": "diff", "diff": {"rows": [], "links": [{"change": "added", "from": "ideas_nb", "to": "+2"}]}}]},
    ("D-E106", 4): {
        "ruling": "G10", "expect": "20137a89",
        "why": "the note of the turn before is the second note created: +2, $c2",
        "ref": [{"tool": "act", "args": {"verb": "delete", "rows": "$c2"}}],
        "gold": [{"type": "diff", "diff": {"rows": [{"key": "+2", "change": "trashed"}], "links": []}}]},
    ("D-E106", 5): {
        "ruling": "G10", "expect": "5c6fa26f",
        "why": "the note of the turn before is the second note created: +2",
        "gold": [{"type": "diff", "diff": {"rows": [{"key": "+2", "change": "restored"}], "links": []}}]},
    ("A-E110", 2): {
        "ruling": "G12", "expect": "a3f7246d",
        "why": "'the work one' among notes that mention the roadmap: the note in the Work notebook, or the note named "
               "'...at work'; both are defensible",
        "add": [{"type": "rows", "rows": ["j3"]}]},
    ("A-E110", 3): {
        "ruling": "G12", "expect": "07c18317",
        "why": "'add ... to it' follows whichever note 'the work one' picked",
        "add": [{"type": "diff", "diff": {"rows": [{"key": "j3", "change": "updated",
                                                    "fields": {"body": {"has": ["recap"]}}}], "links": []}}]},
    ("D-E036", 1): {
        "ruling": "G15", "expect": "85e21ee4",
        "why": "'lucia's birthday is march 3rd': a person has no birthday field, so decline; an event on 3 March is as "
               "good a reading",
        "add": [{"type": "diff", "diff": {"rows": [{"new": "event", "fields": {"name": {"has": ["lucia"]},
                                                                                 "date": "2027-03-03"}}],
                                          "links": []}},
                # the event is all-day and the vault refuses it against the 16:00 ballet of that day (no_busy_conflict):
                # the effect of that reading is the runtime's ask over the clash
                {"type": "ask", "candidates": ["ballet130"]}]},
    ("T12-098", 5): {
        "ruling": "G16", "expect": "b9906ef7",
        "why": "the dates line resolves a bare 'thursday' to this Thursday; the gold meant last Thursday, so the message "
               "says so",
        "user": "and from last week up to last thursday 9pm"},
    ("T12-080", 2): {
        "ruling": "G17", "expect": "134fdc3d",
        "why": "'anything else on for this week': what is on is the events as much as the tasks",
        "add": [{"type": "rows", "rows": ["staff_0817", "shift_plan", "haruto_coffee", "checkup", "open_day", "ito_call",
                                          "pork_0820", "acct_aug", "dentist_me", "shun_coffee", "swim_0822",
                                          "call_0823"]}]},
    ("D-E098", 1): {
        "ruling": "G18", "expect": "c99a71a4",
        "why": "'the guadalajara lists': the four packing lists alone, or those and the shopping list",
        "add": [{"type": "rows", "rows": ["nn56", "nn57", "nn58", "nn59"]}]},
    ("T03-073", 2): {
        "ruling": "G21", "expect": "0e395b1b",
        "why": "three events of that name and 'sunday' said one turn earlier: the Sunday one, or an ask with the two "
               "upcoming ones",
        "add": [{"type": "ask", "candidates": ["handover_1018", "handover_1101"]}]},
    ("D-E134", 4): {
        "ruling": "G11", "expect": "3c1e3d96", "derive": True,
        "why": "right after the user starred the guest wifi, 'the wifi password' is that one: focus wins over an ask (the "
               "gold is derived: focus-wins)",
        "ref": [{"tool": "act", "args": {"verb": "reveal", "rows": "$guest_wifi_d", "args": "field: password"}}]},
    ("D-E066", 1): {
        "ruling": "A1", "expect": "e9020b3e",
        "why": "'the december numbers' singles out the one of the five open duplicates that is due in December (tk742; the "
               "other December one is completed): the turn completes it; the ask over all five stays an accepted answer, "
               "asking is the safe outcome",
        "ref": [{"tool": "act", "args": {"verb": "complete", "kind": "task", "name": "update budget spreadsheet",
                                         "when": "{\"unit\":\"month\",\"rel\":0,\"name\":12}"}}],
        "gold": [{"type": "diff", "diff": {"rows": [{"key": "tk742", "change": "updated",
                                                     "fields": {"status": "completed", "completed": {"any": True}}}],
                                           "links": []}},
                 {"type": "ask", "candidates": ["tk26", "tk132", "tk192", "tk625", "tk742"]}]},
    ("D-E132", 1): {
        "ruling": "M1d-next", "expect": "dfaeafc8",
        "why": "'book club members, for the invite to the next one': the people linked to the Book club group are its "
               "members; a 'next' or 'last one' does not touch a call linked to a row of another kind, so the call is no "
               "longer redirected to the next Book club event (which has no people); the old empty gold was the old "
               "runtime's artifact",
        "gold": [{"type": "rows", "rows": ["pp40", "pp41", "liz", "me", "pp42"]}]},
    ("D-E053", 3): {
        "ruling": "G13", "expect": "fa33e469", "derive": True,
        "why": "'just the ones i already finished' is bounded by its wording: the write is a delete of the completed tasks, "
               "and the runtime's cap asks (the gold is derived: bulk-cap)",
        "ref": [{"tool": "act", "args": {"verb": "delete", "kind": "task", "where": "status = \"completed\""}}]},
    ("A-E011", 3): {
        "ruling": "G2", "expect": "8ffac8f1",
        "why": "'what's still open on errands besides that' follows 'bring it back' (the restore of the "
               "library books): the row the turn before wrote and the message names stays out of the "
               "answer; the old gold listed it (the reference read had no exclude)",
        "ref": [{"tool": "answer", "args": {"kind": "task", "linked_to": "$errands", "where": "status = open", "exclude": "$library"}}],
        "gold": [{"type": "rows", "rows": ["dogfood", "amazon", "carreg", "drycleaning", "passphotos", "gift", "ammapkg", "vetbill"]}]},
    ("B-E101", 4): {
        "ruling": "G2", "expect": "0e901c5d",
        "why": "'who else is on that, besides ama': the message names ama, so she is left out; the old gold "
               "listed her",
        "ref": [{"tool": "answer", "args": {"kind": "person", "linked_to": "$recital", "exclude": "$ama"}}],
        "gold": [{"type": "rows", "rows": ["sarah_n", "efua"]}]},
    ("D-E085", 4): {
        "ruling": "G2", "expect": "ba2f92f3",
        "why": "'what else is that weekend' right after 'move it an hour earlier': the party the turn "
               "before moved is left out",
        "ref": [{"tool": "answer", "args": {"kind": "event", "when": "{\"from\":{\"date\":\"2027-01-16\"},\"to\":{\"date\":\"2027-01-17\"}}", "exclude": "$gabi_party"}}],
        "gold": [{"type": "rows", "rows": ["call_mama158"]}]},
    ("D-E100", 4): {
        "ruling": "G2", "expect": "0627e275",
        "why": "'monday morning, what else' right after 'push the dentist to 9': the dentist the turn "
               "before moved is left out",
        "ref": [{"tool": "answer", "args": {"kind": "event", "when": "{\"from\":{\"unit\":\"week\",\"rel\":1,\"weekday\":1,\"time\":\"08:00\"},\"to\":{\"unit\":\"week\",\"rel\":1,\"weekday\":1,\"time\":\"12:00\"}}", "exclude": "$dentist_kids"}}],
        "gold": [{"type": "rows", "rows": ["standup154"]}]},
    ("T03-059", 3): {
        "ruling": "G2", "expect": "459aef1d",
        "why": "'any other notes with garlic' right after the edit that put garlic in the francesinha note: "
               "that note is left out, so nothing is left",
        "ref": [{"tool": "answer", "args": {"kind": "note", "where": "body contains \"garlic\"", "exclude": "$francesinha"}}],
        "gold": [{"type": "rows", "rows": []}]},
    ("B-E048", 3): {
        "ruling": "G3", "expect": "ef6dce7f",
        "why": "'how long is it': the row (it shows its duration) is as good an answer as the value; "
               "widen_superlative cannot derive an event's duration (the world has start and end)",
        "add": [{"type": "rows", "rows": ["dentist_ev"]}]},
    ("C-E052", 4): {
        "ruling": "G3", "expect": "ddb6e4e6",
        "why": "'the biggest one of those, how much': the row beside the value; widen_superlative cannot "
               "resolve a where-selected reference",
        "add": [{"type": "rows", "rows": ["sophie_tix"]}]},
    ("D-E093", 3): {
        "ruling": "G3", "expect": "eeaa6365",
        "why": "'how long is the longest one': the row beside the value; four January events tie at 75 "
               "minutes, so each is the longest (the ordered read returns soccer_prac122)",
        "add": [{"type": "rows", "rows": ["soccer_prac122"]},
                {"type": "rows", "rows": ["soccer_prac123"]},
                {"type": "rows", "rows": ["soccer_prac124"]},
                {"type": "rows", "rows": ["soccer_prac125"]}]},
    ("D-E098", 4): {
        "ruling": "G3", "expect": "31cbae0f",
        "why": "'how long is the packing task': the row beside the value; widen_superlative cannot resolve "
               "a by-name reference",
        "add": [{"type": "rows", "rows": ["pack_gdl"]}]},
    ("T23-050", 4): {
        "ruling": "G3", "expect": "98a69e9d",
        "why": "'smallest open debt each way': the smallest debt of each direction beside the grouped value",
        "add": [{"type": "rows", "rows": ["d_nigora", "d_gulnora"]}]},
    ("A-E004", 1): {
        "ruling": "G25", "expect": "8d046649",
        "why": "'who' asks for people (SPEC 8.7) and a debt row does not name the person; the people of the "
               "debts are accepted beside the debts",
        "add": [{"type": "rows", "rows": ["arjun", "farah", "jordan_b", "kenji"]}]},
    ("A-E071", 1): {
        "ruling": "G25", "expect": "b6efa5dc",
        "why": "'who' asks for people (SPEC 8.7) and a debt row does not name the person; the people of the "
               "debts are accepted beside the debts",
        "add": [{"type": "rows", "rows": ["bev", "chloe", "jordan_b", "meera_i"]}]},
    ("B-E061", 1): {
        "ruling": "G25", "expect": "72139445",
        "why": "'who' asks for people (SPEC 8.7) and a debt row does not name the person; the people of the "
               "debts are accepted beside the debts",
        "add": [{"type": "rows", "rows": ["adwoa", "dan_k", "tutor"]}]},
    ("C-E052", 1): {
        "ruling": "G25", "expect": "64b75463",
        "why": "'who' asks for people (SPEC 8.7) and a debt row does not name the person; the people of the "
               "debts are accepted beside the debts (the same settle of the shoes stays part of the accept)",
        "add": [{"type": "rows", "rows": ["priya", "sophie"], "diff": {"rows": [{"key": "alexm_shoes", "change": "updated", "fields": {"status": "settled"}}], "links": []}}]},
    ("C-E078", 1): {
        "ruling": "G25", "expect": "835e3e67",
        "why": "'who' asks for people (SPEC 8.7) and a debt row does not name the person; the people of the "
               "debts are accepted beside the debts",
        "add": [{"type": "rows", "rows": ["alex_m", "priya", "sophie"]}]},
    ("T23-069", 3): {
        "ruling": "G25", "expect": "a65e53c8",
        "why": "'who's that to' asks for the person; the debt row the old gold listed names no one (p7, p6 "
               "and Sonnet all answer the person)",
        "add": [{"type": "rows", "rows": ["javlon"]}]},
    ("T03-052", 3): {
        "ruling": "D-1044-15", "expect": "a65e53c8",
        "why": "B6, 'who's that to' about the biggest debt i owe: the person (Marta) or the debt row (150 EUR, Marta's "
               "half of the glasses); the debt rows and the people they link to are both answers (debt-or-person)",
        "add": [{"type": "rows", "rows": ["d_glasses"]}]},
    ("D-E132", 2): {
        "ruling": "D-1044-15", "expect": "6f77f64c",
        "why": "B13, 'what's my number for that one' after the book club members: the balance with the group, an ask "
               "which number is meant, or the out_of_scope decline (the vault holds no phone number); no rule is stated",
        "add": [{"type": "ask", "candidates": []}, {"type": "decline", "reasons": ["out_of_scope"]}]},
    # B17 (D-1044-15): the ask over a series stands, and a by-#n pick of the one instance not over, made after a look, is
    # accepted beside it
    ("A-E091", 1): {
        "ruling": "D-1044-15", "expect": "9731cf28",
        "why": "B17, a by-#n pick of the one instance not over stands beside the ask",
        "add": [{"type": "diff", "diff": {"rows": [{"key": "guests", "change": "trashed"}], "links": []}}]},
    ("T23-044", 4): {
        "ruling": "D-1044-15", "expect": "0a4d6292",
        "why": "B17, a by-#n pick of the one instance not over stands beside the ask",
        "add": [{"type": "diff", "diff": {"rows": [{"key": "javlon_call_2", "change": "updated",
                                                    "fields": {"date": "2026-08-09T21:00"}}], "links": []}}]},
    ("T23-077", 5): {
        "ruling": "D-1044-15", "expect": "7ff2d980",
        "why": "B17, a by-#n pick of the one instance not over stands beside the ask",
        "add": [{"type": "diff", "diff": {"rows": [{"key": "cardio", "change": "updated",
                                                    "fields": {"date": "2026-08-11T11:00"}}], "links": []}}]},
    ("T23-105", 1): {
        "ruling": "D-1044-15", "expect": "0da17dfb",
        "why": "B17, a by-#n pick of the one instance not over stands beside the ask",
        "add": [{"type": "diff", "diff": {"rows": [{"key": "javlon_call_2", "change": "updated",
                                                    "fields": {"date": "2026-08-09T20:30"}}], "links": []}}]},
    ("T23-108", 1): {
        "ruling": "D-1044-15", "expect": "dcef1760",
        "why": "B17, a by-#n pick of the one instance not over stands beside the ask",
        "add": [{"type": "diff", "diff": {"rows": [{"key": "gift", "change": "updated",
                                                    "fields": {"date": "2026-08-07"}}], "links": []}}]},
    ("test-D-008", 2): {
        "ruling": "G13", "expect": "460527a1",
        "why": "t1 accepts the 13-row set of Christmas photos; 'star all of them' over 13 rows is over the "
               "cap (D-1044-12), so the turn ends in the runtime's ask",
        "add": [{"type": "ask", "candidates": []}]},
    ("A-E051", 1): {
        "ruling": "G26", "expect": "d1774253",
        "why": "'before december' bounds the read: the album due 10 December is not before December; the "
               "bounded set is accepted beside the old one",
        "add": [{"type": "rows", "rows": ["callamma", "ammapkg"]}]},
    ("A-E051", 2): {
        "ruling": "G26", "expect": "4d6e996d",
        "why": "the biggest of the bounded set of the turn before",
        "add": [{"type": "rows", "rows": ["ammapkg"]}]},
    ("A-E051", 3): {
        "ruling": "G26", "expect": "c667f7bb",
        "why": "'push it to the twentieth' on the bounded set moves the package due the 18th (the album is "
               "due in December)",
        "add": [{"type": "diff", "diff": {"rows": [{"key": "ammapkg", "change": "updated", "fields": {"date": "2026-10-20"}}], "links": []}}]},
    ("D-E058", 4): {
        "ruling": "G9", "expect": "21f0ca65",
        "why": "'what about the old comcast login' right after the refused 'bring her back' is a "
               "substitution fragment (SPEC 8.8) and carries the restore; the vault refuses it past the "
               "window, so the turn ends in the runtime's decline not_found",
        "add": [{"type": "decline", "reasons": ["not_found"]}]},
    ("T03-026", 3): {
        "ruling": "G27", "expect": "9dd7694c",
        "why": "'his role's physics teacher and deputy director': the role in the person's own words is as "
               "good as the comma form",
        "add": [{"type": "diff", "diff": {"rows": [{"key": "pedro_a", "change": "updated", "fields": {"role": "physics teacher and deputy director"}}], "links": []}}]},
}


def digest(text: str) -> str:
    return hashlib.sha1(text.encode()).hexdigest()[:8]


def apply_fix(turn: dict, fix: dict, sid: str, number: int) -> dict:
    """The turn with a fix applied. Idempotent. Raises when the fix was written for another message."""
    new = fix.get("user")
    if digest(turn["user"]) != fix["expect"] and turn["user"] != new:
        raise ValueError(f"{sid} t{number}: fix {fix['ruling']} was written for another message")
    out = dict(turn)
    if new and turn["user"] != new:
        out["user"], out["rewritten"] = new, f"{fix['ruling']}: was {turn['user']!r}"
    if "ref" in fix:
        out["ref"] = copy.deepcopy(fix["ref"])
    if "gold" in fix:
        out["gold"] = copy.deepcopy(fix["gold"])
    if "add" in fix:
        have = {canon_accept(a) for a in out["gold"]}
        out["gold"] = out["gold"] + [copy.deepcopy(a) for a in fix["add"] if canon_accept(a) not in have]
    return out


def pinned(sid: str, number: int) -> bool:
    """The gold of this turn is a hand correction: the reference run must satisfy it as it stands."""
    fix = FIXES.get((sid, number))
    return bool(fix) and not fix.get("derive") and ("gold" in fix or "add" in fix)


def rewrite_messaging(turn: dict, last: bool) -> dict | None:
    """G1: the last turn of a session that asks to message someone, whose gold asks which someone (or logs a message),
    is a decline out_of_scope. Only the last turn: a later turn would answer the ask that is no longer asked."""
    if not last or not is_messaging(turn["user"]) or turn["gold"][0]["type"] not in ("ask", "diff"):
        return None
    if turn["gold"] == [gold.decline("out_of_scope")]:
        return None
    return {**turn, "ref": [{"tool": "decline", "args": {"reason": "out_of_scope"}}],
            "gold": [gold.decline("out_of_scope")]}


def rewrite_due_active(turn: dict) -> dict | None:
    """G23: the reference read of "what's due <span>" says `status = open`. The read is the last answer, find or compute
    of the turn over tasks with a `when`, no status condition, no container and no row handle; the gold is derived from
    the run (`due-active`)."""
    if not DUE.search(turn["user"]) or EVERY.search(turn["user"]) or not turn.get("ref"):
        return None
    if turn["gold"][0]["type"] not in ("rows", "value"):
        return None
    at = max((i for i, c in enumerate(turn["ref"]) if c.get("tool") in ("answer", "find", "compute")), default=None)
    if at is None:
        return None
    args = turn["ref"][at].get("args") or {}
    where = args.get("where")
    if (args.get("kind") != "task" or not args.get("when") or any(args.get(k) for k in
                                                                    ("linked_to", "within", "rows", "value", "name"))
            or (isinstance(where, str) and status_clauses(where))):
        return None
    ref = copy.deepcopy(turn["ref"])
    ref[at]["args"]["where"] = f"{where} and status = open" if where else "status = open"
    return {**turn, "ref": ref}


@lru_cache(maxsize=None)
def world_kinds(world: str) -> dict[str, str]:
    """The kind of every row of a world, by world key."""
    spec = load_world(world)
    return {row["key"]: kind for section, kind in SECTION_KIND.items() for row in spec.get(section, []) if row.get("key")}


def rewrite_kindless(turn: dict, prev: str | None, kind_of) -> dict | None:
    """K1: the reference read of a kind-less "what's left this weekend" or "what's still on today" names the kind that
    `kindless_reading` gives it (`prev` is the task or event the turn before read or wrote), unless the gold already accepts
    rows of that kind. An event has no `open`: the status conditions of the call go when it is read as events. The gold is
    derived from the run (`kindless`)."""
    ref = turn.get("ref") or []
    core = _core_call(ref)
    reading = kindless_reading(turn["user"], prev) if _listing(core) else None
    if reading is None or reading[0] == core["kind"] or turn["gold"][0]["type"] != "rows":
        return None
    if reading[0] in gold_kinds(turn["gold"], kind_of):
        return None
    at = max(i for i, c in enumerate(ref) if c.get("tool") in ("answer", "find", "compute")
             and not (c.get("args") or {}).get("value"))
    out = copy.deepcopy(ref)
    args = out[at]["args"]
    args["kind"] = reading[0]
    if reading[0] == "event" and isinstance(args.get("where"), str):
        rest = [c for c in clauses(args["where"]) if not STATUS_CLAUSE.match(c)]
        if rest:
            args["where"] = " and ".join(rest)
        else:
            del args["where"]
    return {**turn, "ref": out}


def _prev_kind(turns: list[dict], kind_of) -> str | None:
    """The task or event that the latest of the turns read or wrote."""
    return next((k for t in reversed(turns) if (k := dated_kind(t, kind_of))), None)


def _kindless_candidate(turn: dict) -> bool:
    """The message and the reference read say a kind-less read of a span of time (whatever the turn before was)."""
    return (any(kindless_reading(turn["user"], prev) for prev in (None, "task", "event"))
            and _listing(_core_call(turn.get("ref") or [])))


def prepare_session(session: dict, fixes: bool = True) -> tuple[dict, list[dict]]:
    """The session as the reference run should see it: the rewrite conventions (`messaging`, `due-active`) and the fixes of
    FIXES applied, and one row per turn changed. Idempotent: a prepared session comes back as it is. `fixes=False` applies
    the conventions only: that is what a test session gets (D-1044-13, D-1044-14), whatever its id."""
    turns, rows = [], []
    for ti, turn in enumerate(session["turns"]):
        fix = FIXES.get((session["id"], ti + 1)) if fixes else None
        if fix:
            new, label, why = apply_fix(turn, fix, session["id"], ti + 1), f"fix {fix['ruling']}", fix["why"]
        elif (new := rewrite_messaging(turn, ti == len(session["turns"]) - 1)):
            label, why = "messaging", "a request to message someone is out of scope; the reference calls decline"
        elif (new := rewrite_due_active(turn)):
            label, why = "due-active", "the reference read of a due span says status = open (G23)"
        elif _kindless_candidate(turn) and (new := rewrite_kindless(
                turn, _prev_kind(turns, world_kinds(session["world"]).get), world_kinds(session["world"]).get)):
            label, why = "kindless", (f"a kind-less 'left' or 'on' reads {_core_call(new['ref'])['kind']}s: "
                                      "the reference read names that kind (K1)")
        else:
            new = turn
        if new != turn:
            rows.append({"id": session["id"], "turn": ti + 1, "user": turn["user"], "convention": label, "why": why,
                         "old_gold": turn["gold"], "new_gold": new["gold"], "ref_changed": new.get("ref") != turn.get("ref")})
        turns.append(new)
    return ({**session, "turns": turns} if rows else session), rows


def prepare_sets(sets_dir: Path, out: Path, names: list[str]) -> dict[str, list[dict]]:
    """Write `prepare_session` of every session of the sets to `out` (the input of the reference run) and return the
    rows per set. Test ids in FIXES are refused."""
    out.mkdir(parents=True, exist_ok=True)
    found: dict[str, list[dict]] = {}
    for name in names:
        lines = [line for line in (sets_dir / f"{name}.jsonl").read_text(encoding="utf-8").split("\n") if line.strip()]
        rows: list[dict] = []
        with open(out / f"{name}.jsonl", "w", encoding="utf-8") as handle:
            for line in lines:
                session = json.loads(line)
                if name == "test" and any(sid == session["id"] for sid, _ in FIXES):
                    raise SystemExit(f"{session['id']} is a test session: test ids are never fixed by hand")
                new, got = prepare_session(session, fixes=name != "test")  # conventions only on test
                handle.write((line if new is session else json.dumps(new, ensure_ascii=False)) + "\n")
                rows += got
        found[name] = rows
    return found


def prepared_markdown(found: dict[str, list[dict]]) -> str:
    """The list of what prepare changed: val with the reason of every turn, test with ids and conventions only."""
    lines = ["# Prepared sets (D-1044-13)", ""]
    for name, rows in found.items():
        by: dict[str, int] = {}
        for r in rows:
            by[r["convention"]] = by.get(r["convention"], 0) + 1
        lines += [f"- {name}: {len(rows)} turns prepared in {len({r['id'] for r in rows})} sessions; "
                  + (", ".join(f"{k} {v}" for k, v in sorted(by.items())) or "none")]
    for name, rows in found.items():
        lines += ["", f"## {name}", ""]
        if name == "test":
            lines += ["| session | turn | convention |", "| --- | --- | --- |"]
            lines += [f"| {r['id']} | {r['turn']} | {r['convention']} |" for r in rows]
        else:
            lines += ["| convention | session | turn | why | old gold | new gold |", "| --- | --- | --- | --- | --- | --- |"]
            lines += ["| " + " | ".join(str(x).replace("|", "\\|") for x in (
                r["convention"], r["id"], r["turn"], r["why"], show_gold(r["old_gold"]),
                show_gold(r["new_gold"]) if r["new_gold"] != r["old_gold"] else "(derived from the run)")) + " |"
                for r in rows]
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    """`prepare`: write the prepared sets. `refreeze`: prepare, then build_sets.refreeze over them (one command)."""
    import argparse

    here = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    for cmd in ("prepare", "refreeze"):
        p = sub.add_parser(cmd)
        p.add_argument("--out", type=Path, required=True)
        p.add_argument("--sets-dir", type=Path, default=here / "sets")
        p.add_argument("--sets", default="val,test")
        if cmd == "refreeze":
            p.add_argument("--ref-out", type=Path)
            p.add_argument("--jobs", type=int, default=8)
    args = parser.parse_args(argv)
    names = args.sets.split(",")
    pre = args.out / "pre"
    found = prepare_sets(args.sets_dir, pre, names)
    (args.out / "prepared.md").write_text(prepared_markdown(found), encoding="utf-8")
    for name, rows in found.items():
        by: dict[str, int] = {}
        for r in rows:
            by[r["convention"]] = by.get(r["convention"], 0) + 1
        print(f"{name}: {len(rows)} turns prepared ({', '.join(f'{k} {v}' for k, v in sorted(by.items())) or 'none'})")
    if args.cmd == "prepare":
        return 0
    sys.path.insert(0, str(here))
    import build_sets  # noqa: PLC0415  (build_sets imports this module)

    return build_sets.refreeze(args.out / "sets", args.ref_out, names, args.jobs, pre)



# ---------------------------------------------------------------------------------------------
# Change lists
# ---------------------------------------------------------------------------------------------


def _amount(v: dict) -> str:
    return f"{v['amount']}" + (f" {v['unit']}" if v.get("unit") else "")


def _fields(fields: dict) -> str:
    """The fields of a row spec with their values: `status=completed, completed=*` (* is any value)."""
    def one(v) -> str:
        if isinstance(v, dict):
            text = "*" if v.get("any") else json.dumps(v, ensure_ascii=False)
        else:
            text = str(v)
        return text if len(text) <= 40 else text[:37] + "..."
    return ", ".join(f"{k}={one(v)}" for k, v in fields.items())


def show_accept(a: dict) -> str:
    """An accepted effect on one line."""
    t = a["type"]
    if t == "rows":
        text = "rows " + ", ".join(a["rows"]) + (" (ordered)" if a.get("order") else "")
    elif t == "value" and "groups" in a:
        text = "value " + "; ".join(f"{k}: {' / '.join(_amount(v) for v in vs)}" for k, vs in a["groups"].items())
    elif t == "value":
        text = "value " + " / ".join(_amount(v) for v in a["values"])
    elif t == "ask":
        text = "ask " + (", ".join(a["candidates"]) or "(no candidates)")
    elif t == "decline":
        text = "decline " + "/".join(a["reasons"])
    else:
        text = "diff"
    diff = a.get("diff") or {}
    if diff.get("rows") or diff.get("links"):
        specs = []
        for r in diff["rows"]:
            if "new" in r:
                specs.append(f"+{r['new']}" + "{" + _fields(r.get("fields", {})) + "}")
            elif r.get("change", "updated") == "updated":
                specs.append(f"{r['key']}~" + "{" + _fields(r.get("fields", {})) + "}")
            else:
                specs.append(f"{r['key']} {r['change']}")
        specs += [f"link {x['change']} {x['from']}->{x['to']}" for x in diff["links"]]
        text += (" " if t == "diff" else " + ") + "; ".join(specs)
    for name in ("already", "settle", "reveal"):
        if a.get(name):
            text += f" [{name} {len(a[name])}]"
    return text


def show_gold(accepts: list[dict] | None) -> str:
    return " OR ".join(show_accept(a) for a in accepts) if accepts else "(none)"


def summarize(changes: list[dict], sessions: int, turns: int) -> dict:
    """Counts of a change list: turns changed by convention, the turns held (name-match) and the UNEXPLAINED ones
    with their ids, sessions touched."""
    by: dict[str, int] = {}
    for c in changes:
        if c["applied"]:
            by[c["convention"]] = by.get(c["convention"], 0) + 1
    unexplained = [f"{c['id']} t{c['turn']}" for c in changes if c["convention"] == UNEXPLAINED]
    held = [f"{c['id']} t{c['turn']}" for c in changes if c["held"]]
    return {"sessions": sessions, "turns": turns,
            "turns_changed": sum(by.values()),
            "failed_the_old_gold": sum(1 for c in changes if c["applied"] and c["was_failing"]),
            "tightened_though_passing": sum(1 for c in changes if c["applied"] and not c["was_failing"]),
            "by_convention": dict(sorted(by.items())),
            "unexplained": len(unexplained), "unexplained_ids": unexplained,
            "name_match": len(held), "name_match_ids": held,
            "sessions_touched": len({c["id"] for c in changes if c["applied"]})}


if __name__ == "__main__":
    raise SystemExit(main())
