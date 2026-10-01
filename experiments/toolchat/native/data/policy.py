"""SPEC §8 as code: abstract requests -> steps, every step executed on the REAL runtime.

The executor decides each call from (a) the request's decision variables (what the message
means, which words name things, which date phrase) and (b) what the rendered context shows
(directory, this turn's vault block, rows shown earlier). It never predicts an observation:
it sends the call and reacts to the runtime's reply (§8.5, §8.6, §8.10, §8.12).
The §7 trace of each step is written from the same decision variables before the call.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field

from dates import DatePhrase
from meta import VERBS_BY_KIND

KIND_PLURAL = {"groups": "group", "albums": "album", "notebooks": "notebook", "folders": "folder", "lists": "list"}
KINDS = ["person", "group", "event", "task", "note", "document", "photo", "album", "debt", "locker item",
         "notebook", "folder", "list"]
KIND_RX = "|".join(sorted((re.escape(k) for k in KINDS), key=len, reverse=True))
ROW_RX = re.compile(r"#(\d+) (?:\[\d+\] )?(" + KIND_RX + r') "([^"]*)"')
LINK_RX = re.compile(r"(" + KIND_RX + r') #(\d+) "([^"]*)"')
# after the runtime's compaction fix, an observation not yet compacted keeps its rows addressable
ADDRESS_WHOLE_OBS = os.environ.get("NATIVE_WHOLE_OBS", "1") == "1"
KEPT_RX = re.compile(r"\(compacted; ([#\d, ]+) kept\)")
PARAM_ORDER = {
    "search": ["text", "kind"],
    "find": ["kind", "name", "where", "when", "linked_to", "within", "exclude", "order", "limit", "trashed"],
    "compute": ["op", "field", "group", "rows", "kind", "name", "where", "when", "linked_to", "within", "exclude",
                "order", "limit", "trashed"],
    "answer": ["op", "field", "value", "rows", "kind", "name", "where", "when", "linked_to", "within", "exclude",
               "order", "limit", "trashed"],
    "act": ["verb", "rows", "kind", "name", "where", "when", "linked_to", "within", "exclude", "order", "limit",
            "trashed", "args", "more"],
    "open": ["row"],
    "ask": ["question", "options"],
    "decline": ["reason"],
}
STOP = {"the", "a", "an", "my", "of", "for", "to", "and", "with", "in", "on", "at", "from", "by", "me"}


def words(s: str) -> list[str]:
    return [w.lower() for w in re.findall(r"\w+", s)]


def canon_expr(e: dict) -> dict:
    if "from" in e or "to" in e:
        return {k: canon_expr(e[k]) for k in ("from", "to") if k in e}
    out = {}
    for k in ("date", "unit", "name", "rel", "weekday", "time", "anchor"):
        if k in e:
            out[k] = e[k]
    return out


def expr_json(e: dict) -> str:
    return json.dumps(canon_expr(e), ensure_ascii=False)


class GenError(Exception):
    """The generator's own call failed or the world did not do what the scenario needs: drop it."""


# ------------------------------------------------------------------ requests
@dataclass
class Ref:
    """A row the call must name by #n (linked_to, to:, from:, group:, person:)."""
    kind: str
    phrase: str           # as typed
    words: list[str]      # search words
    key: str              # model key (expected row)


@dataclass
class Target:
    mode: str                       # name | pick | rows_kept | none
    phrase: str = ""                # as typed
    words: list = field(default_factory=list)
    keys: list = field(default_factory=list)   # expected target keys
    pick_why: str = ""              # pick: what the description means ("the dentist one")
    look: dict | None = None        # pick: the call that shows candidates {"tool":"find"|"search", args}


@dataclass
class Action:
    tool: str                        # answer | act | compute
    kind: str | None = None          # one kind or comma list
    target: Target | None = None
    refs: dict = field(default_factory=dict)      # role -> Ref
    where: str | None = None
    where_note: str | None = None    # reading of the condition for the trace
    when: DatePhrase | None = None
    order: str | None = None
    limit: int | None = None
    trashed: bool = False
    within: str | None = None        # "@n" (follow-ups)
    exclude: str | None = None
    op: str | None = None
    field_: str | None = None
    group: str | None = None
    verb: str | None = None
    args: list = field(default_factory=list)      # [(name, value)] value: str | DatePhrase | Ref
    bulk: bool = False               # several rows intended: find first, then act rows=@n
    note: str = ""                   # extra plan note for the trace
    lines: list = field(default_factory=list)     # extra trace lines (decision variables)


@dataclass
class Req:
    family: str
    intent: str                      # rows | value | group | write | multi | ask | decline | undo
    reading: str                     # intent line body
    named: list = field(default_factory=list)
    actions: list = field(default_factory=list)
    decline: str | None = None
    follow: str | None = None
    settle: str | None = None        # key the message settles an ambiguity on
    pattern: str = "first"
    expect: str = ""                 # rows | changed | already | ask | decline | recover | ...
    message: str = ""
    slots: dict = field(default_factory=dict)
    tags: set = field(default_factory=set)


# ------------------------------------------------------------------ session state
@dataclass
class RowView:
    n: int
    kind: str
    name: str


class State:
    def __init__(self, prompt: dict):
        self.system = prompt["system"]
        self.tools = prompt["tools"]
        self.directory: dict[int, RowView] = {}
        for line in self.system.split("vault directory:")[-1].splitlines() if "vault directory:" in self.system else []:
            m = re.match(r"(\w+): (.*)", line.strip())
            if not m or m.group(1) not in KIND_PLURAL:
                continue
            for nm, n in re.findall(r"(.+?) \(#(\d+)\)(?:, |$)", m.group(2)):
                nm = nm.strip()
                if nm.startswith("+") and "more" in nm:
                    continue
                self.directory[int(n)] = RowView(int(n), KIND_PLURAL[m.group(1)], nm)
        self.turn_rows: dict[int, RowView] = {}
        self.kept: dict[int, RowView] = {}
        self.seen_names: dict[int, RowView] = dict(self.directory)   # every row shown so far
        self.preground: dict[int, RowView] = {}
        self.handles: list[str] = []
        self.obs_text: dict[int, str] = {}
        self.messages: list[dict] = []   # rendered chat (earlier turns compacted), without system
        self.turns: list[dict] = []      # per turn: {"req","steps","msg_start"}
        self.last_result: str | None = None   # @n of the previous turn's answer rows
        self.id_n: dict[str, int] = {}          # vault id -> #n, from the runtime's effects
        self.obs_rows: dict[int, dict] = {}     # rows of observations still shown whole
        self.prev_turn_writes = False

    # -- parsing
    def rows_in(self, text: str) -> dict[int, RowView]:
        out = {}
        for n, k, nm in ROW_RX.findall(text):
            out[int(n)] = RowView(int(n), k, nm)
        for k, n, nm in LINK_RX.findall(text):
            out.setdefault(int(n), RowView(int(n), k, nm))
        return out

    def addressable(self) -> dict[int, RowView]:
        d = dict(self.directory)
        d.update(self.kept)
        for rows in self.obs_rows.values():
            d.update(rows)
        d.update(self.turn_rows)
        return d

    def on_user(self, resp: dict) -> None:
        # rows stay addressable while their observation is shown whole; a compacted result keeps only
        # the rows it lists as kept (the runtime says which observations it compacts)
        self.turn_rows = {}
        for c in resp.get("compacted", []):
            self.obs_rows.pop(c["obs"], None)
            self.obs_text[c["obs"]] = c["text"]
            m = KEPT_RX.search(c["text"])
            if m:
                shown = self.rows_in(c["text"])
                for h in re.findall(r"#(\d+)", m.group(1)):
                    n = int(h)
                    if n in shown:
                        self.kept[n] = shown[n]
                    elif n in self.seen_names:
                        self.kept[n] = self.seen_names[n]
            # update the rendered tool message
            for msg in self.messages:
                if msg.get("obs") == c["obs"]:
                    msg["content"] = c["text"]
        self.preground = self.rows_in(resp.get("preground") or "")
        self.turn_rows.update(self.preground)
        self.seen_names.update(self.preground)

    def on_obs(self, resp: dict) -> None:
        text = resp.get("text", "")
        if "obs" in resp:
            self.obs_text[resp["obs"]] = text
        rows = self.rows_in(text)
        eff = resp.get("effect") or {}
        if eff.get("error") or text.startswith("error:"):
            return
        self.turn_rows.update(rows)
        if "obs" in resp and ADDRESS_WHOLE_OBS:
            self.obs_rows[resp["obs"]] = rows
        self.seen_names.update(rows)
        for h in re.findall(r"@(\d+)", text):
            if f"@{h}" not in self.handles:
                self.handles.append(f"@{h}")

    def familiar(self, ws: list[str], kind: str | None) -> list[RowView]:
        """Rows shown so far (directory, vault blocks, observations) whose name has all the words."""
        out = []
        for rv in self.seen_names.values():
            if kind and rv.kind not in kind.split(","):
                continue
            own = set(words(rv.name))
            if ws and all(t in own for w in ws for t in words(w)):
                out.append(rv)
        return out

    def visible_matches(self, ws: list[str], kind: str | None) -> list[RowView]:
        out = []
        for rv in self.addressable().values():
            if kind and rv.kind not in kind.split(","):
                continue
            own = set(words(rv.name))
            if ws and all(t in own for w in ws for t in words(w)):
                out.append(rv)
        return sorted(out, key=lambda r: r.n)


# ------------------------------------------------------------------ executor
@dataclass
class Step:
    think: str
    tool: str
    args: dict
    text: str = ""
    effect: dict | None = None
    ends_turn: bool = False
    obs: int | None = None


def ordered(tool: str, args: dict) -> dict:
    out = {}
    for k in PARAM_ORDER[tool]:
        if k in args and args[k] is not None and args[k] != "":
            v = args[k]
            if isinstance(v, bool):
                v = "true" if v else "false"
            out[k] = v
    extra = set(args) - set(PARAM_ORDER[tool])
    if extra:
        raise GenError(f"unknown params {extra} for {tool}")
    return out


def short(rv: RowView) -> str:
    return f'#{rv.n} {rv.kind} "{rv.name}"'


class Executor:
    def __init__(self, sess, model, state: State, rng):
        self.s = sess
        self.model = model
        self.st = state
        self.rng = rng
        self.steps: list[Step] = []
        self.outcome: list[str] = []

    # ---- low level
    def call(self, think: str, tool: str, args: dict) -> dict:
        a = ordered(tool, args)
        if self.steps and self.steps[-1].tool == tool and self.steps[-1].args == a:
            raise GenError("generator repeated a call")
        if len(self.steps) >= 6:
            raise GenError("step cap")
        resp = self.s.call(tool, a)
        st = Step(think, tool, a, resp.get("text", ""), resp.get("effect"), bool(resp.get("ends_turn")), resp.get("obs"))
        self.steps.append(st)
        self.st.on_obs(resp)
        eff = resp.get("effect") or {}
        if eff.get("error"):
            raise GenError(f"runtime error on {tool} {json.dumps(a)[:300]}: {resp.get('text', '')[:300]}")
        self.apply_diff(eff)
        for coll in (eff.get("rows"), (eff.get("answer") or {}).get("rows"), eff.get("ambiguous"), eff.get("created"),
                     (eff.get("ask") or {}).get("options"), eff.get("already")):
            for x in coll or []:
                if isinstance(x, dict) and x.get("id") and x.get("n"):
                    self.st.id_n[x["id"]] = x["n"]
        for x in ((eff.get("diff") or {}).get("rows") or []):
            if x.get("id") and x.get("n"):
                self.st.id_n[x["id"]] = x["n"]
        return resp

    def apply_diff(self, eff: dict) -> None:
        """Keep the scenario model in step with the vault, from the runtime's own diff."""
        diff = eff.get("diff") or {}
        for row in diff.get("rows", []):
            r = self.model.by_id(row["id"])
            if r is None and row.get("change") == "created":
                from worlds import Row
                nm = (row["fields"].get("name") or [None, "?"])[1]
                key = f"new_{row['id'][:8]}"
                r = Row(key, row["kind"], nm)
                r.id = row["id"]
                self.model.rows[key] = r
            if r is None:
                continue
            for f, (old, new) in row.get("fields", {}).items():
                if f == "name":
                    r.name = new or r.name
                elif f == "trashed":
                    r.trashed = bool(new)
                else:
                    r.fields[f] = new
        for ln in diff.get("links", []):
            a, b = self.model.by_id(ln["from"]["id"]), self.model.by_id(ln["to"]["id"])
            if not a or not b:
                continue
            for x, y in ((a, b), (b, a)):
                if ln["change"] == "added":
                    if y.kind in ("album", "group"):
                        x.containers.add(y.key)
                    elif y.kind in ("notebook", "folder", "list") and x.kind != y.kind:
                        x.container = y.key
                    else:
                        x.links.add(y.key)
                else:
                    x.containers.discard(y.key)
                    x.links.discard(y.key)
                    if x.container == y.key:
                        x.container = None

    def key_of_n(self, n: int) -> str | None:
        for st in reversed(self.steps):
            for coll in ("rows",):
                for r in (st.effect or {}).get(coll, []) or []:
                    if r.get("n") == n:
                        m = self.model.by_id(r["id"])
                        return m.key if m else None
        rv = self.st.addressable().get(n) or self.st.seen_names.get(n)
        if rv:
            cands = [r for r in self.model.rows.values() if r.kind == rv.kind and r.name == rv.name]
            if len(cands) == 1:
                return cands[0].key
        return None

    def n_of_key(self, key: str) -> int | None:
        r = self.model.rows.get(key)
        if not r:
            return None
        if r.id in self.st.id_n and self.st.id_n[r.id] in self.st.addressable():
            return self.st.id_n[r.id]
        # effects carry ids; prefer those
        for st in reversed(self.steps):
            eff = st.effect or {}
            for coll in ("rows", "ambiguous", "created"):
                for x in eff.get(coll, []) or []:
                    if isinstance(x, dict) and x.get("id") == r.id and x.get("n"):
                        if x["n"] in self.st.addressable():
                            return x["n"]
        # addressable rows by exact name + kind, when unique
        cands = [rv for rv in self.st.addressable().values() if rv.kind == r.kind and rv.name == r.name]
        if len(cands) == 1:
            same = [x for x in self.model.rows.values() if x.kind == r.kind and x.name == r.name and not x.trashed]
            if len(same) <= 1 or r.trashed:
                return cands[0].n
        return None

    # ---- refs: rows a call must name by number
    def resolve_ref(self, ref: Ref, notes: list[str]) -> int | None:
        n = self.n_of_key(ref.key)
        if n is not None:
            src = "directory" if n in self.st.directory else ("vault block" if n in self.st.preground else "shown")
            notes.append(f'"{ref.phrase}" = #{n} ({src})')
            return n
        think = (f'need #n for "{ref.phrase}"; not in directory or shown rows · plan: search "{" ".join(ref.words)}"'
                 f" ({ref.kind})")
        self.call(self.first(think), "search", {"text": " ".join(ref.words), "kind": ref.kind})
        n = self.n_of_key(ref.key)
        if n is None:
            return None
        notes.append(f'"{ref.phrase}" = #{n} (search)')
        return n

    # ---- the turn
    def head_think(self) -> str:
        r = self.req
        lines = [f"intent: {r.reading}" + (f" · named: {', '.join(chr(34) + x + chr(34) for x in r.named)}" if r.named else "")]
        if r.follow:
            lines.append(f"follow: {r.follow}")
        return "\n".join(lines)

    def run(self, req: Req) -> list[Step]:
        self.req = req
        self.head_used = False
        if req.intent == "decline":
            self.call(self.first(f"plan: decline {req.decline}"), "decline", {"reason": req.decline})
            self.outcome.append("decline")
            return self.steps
        if req.intent == "undo":
            self.call(self.first("plan: act undo (reverts the whole previous turn)"), "act", {"verb": "undo"})
            self.outcome.append("undo")
            return self.steps
        if req.intent == "ask":
            a = req.actions[0] if req.actions else None
            opts = [self.n_of_key(k) for k in (a.target.keys if a and a.target else [])]
            opts = [o for o in opts if o]
            args = {"question": req.slots.get("_question", "Which one do you mean?")}
            if opts:
                args["options"] = ", ".join(f"#{o}" for o in sorted(opts))
            self.call(self.first("plan: ask (the vault cannot decide)"), "ask", args)
            self.outcome.append("ask")
            return self.steps
        for i, a in enumerate(req.actions):
            last = i == len(req.actions) - 1
            if not self.do_action(a, last):
                break
        return self.steps

    def first(self, body: str) -> str:
        """Prefix the head (intent/named/follow) on the turn's first step only."""
        if not self.head_used:
            self.head_used = True
            return self.head_think() + "\n" + body
        return body

    def kind_line(self, a: Action, conds: list[str], plan: str) -> str:
        parts = []
        if a.kind:
            parts.append(f"kind: {a.kind}")
        if conds:
            parts.append("cond: " + ", ".join(conds))
        parts.append(f"plan: {plan}")
        return " · ".join(parts)

    def conds_of(self, a: Action, name_words: list[str] | None, ref_notes: dict) -> list[str]:
        c = []
        if name_words:
            c.append("name ~ " + " ".join(name_words))
        if a.where:
            c.append(a.where + (f" ({a.where_note})" if a.where_note else ""))
        if a.when:
            c.append("when")
        for role, n in ref_notes.items():
            if role == "linked_to":
                c.append(f"linked to #{n}")
        if a.within:
            c.append(f"within {a.within}")
        if a.order:
            c.append(f"order {a.order}" + (f", limit {a.limit}" if a.limit else ""))
        elif a.limit:
            c.append(f"limit {a.limit}")
        if a.trashed:
            c.append("trashed")
        return c

    def selector(self, a: Action, name: str | None, ref_n: dict) -> dict:
        args: dict = {}
        if a.kind:
            args["kind"] = a.kind
        if name:
            args["name"] = name
        if a.where:
            args["where"] = a.where
        if a.when:
            args["when"] = json.loads(expr_json(a.when.expr))
        if "linked_to" in ref_n:
            args["linked_to"] = f"#{ref_n['linked_to']}"
        if a.within:
            args["within"] = a.within
        if a.exclude:
            args["exclude"] = a.exclude
        if a.order:
            args["order"] = a.order
        if a.limit:
            args["limit"] = a.limit
        if a.trashed:
            args["trashed"] = True
        return args

    def act_args(self, a: Action, ref_n: dict) -> str:
        lines = []
        for k, v in a.args:
            if k == "kind" and a.verb == "create":
                continue                      # create takes kind at the top level; args carry fields only
            if isinstance(v, DatePhrase):
                lines.append(f"{k}: {expr_json(v.expr)}")
            elif isinstance(v, Ref):
                lines.append(f"{k}: #{ref_n[k]}")
            else:
                lines.append(f"{k}: {v}")
        return "\n".join(lines)

    def main_args(self, a: Action, name: str | None, ref_n: dict, rows: str | None, more: bool) -> tuple[str, dict]:
        if a.tool == "act":
            args = {"verb": a.verb}
            if rows:
                args["rows"] = rows
            elif a.verb == "create":
                args["kind"] = dict(a.args).get("kind") or a.kind
            elif a.verb != "undo":
                args.update(self.selector(a, name, ref_n))
            aa = self.act_args(a, ref_n)
            if aa:
                args["args"] = aa
            if more:
                args["more"] = True
            return "act", args
        args = {}
        if a.op:
            args["op"] = a.op
        if a.field_:
            args["field"] = a.field_
        if a.group:
            args["group"] = a.group
        if rows:
            args["rows"] = rows
            if a.kind and a.op == "balance" and "linked_to" in ref_n:
                args.pop("rows")
                args.update(self.selector(a, name, ref_n))
        else:
            args.update(self.selector(a, name, ref_n))
        return a.tool, args

    def do_action(self, a: Action, last: bool) -> bool:
        """Run one action; False when the turn ended early (ask / decline)."""
        ref_notes: list[str] = []
        ref_n: dict = {}
        for role, ref in a.refs.items():
            n = self.resolve_ref(ref, ref_notes)
            if n is None:
                self.call(self.first(f'dead end: "{ref.phrase}" not found by search · plan: decline not_found'),
                          "decline", {"reason": "not_found"})
                self.outcome.append("not_found")
                return False
            ref_n[role] = n
        more = not last
        name = None
        rows = None
        pre_lines = [("seen: " + " · ".join(ref_notes))] if ref_notes else []
        pre_lines += a.lines
        if a.when:
            pre_lines.append(a.when.trace())
        for k, v in a.args:
            if isinstance(v, DatePhrase):
                pre_lines.append(v.trace())
        tgt = a.target
        plan_note = a.note
        if a.verb == "create" and not a.kind:
            a.kind = dict(a.args).get("kind")
        if tgt and tgt.mode == "keys":
            rows = ", ".join(f"#{ref_n[r]}" for r in ("_a", "_b"))
            for r in ("_a", "_b"):
                ref_n.pop(r)
            plan_note = f"act {a.verb} rows={rows} (one write names every row)"
        elif tgt and tgt.mode == "name" and a.tool == "open":
            n = self.resolve_ref(Ref(a.kind, tgt.phrase, tgt.words, tgt.keys[0]), pre_lines)
            if n is None:
                self.call(self.first("search found nothing · plan: decline not_found"), "decline", {"reason": "not_found"})
                self.outcome.append("not_found")
                return False
            if pre_lines and pre_lines[0].startswith('"'):
                pre_lines[0] = "seen: " + pre_lines[0]
            self.call(self.first("\n".join(pre_lines + [f"plan: open #{n} (every fact and link), then answer it"])),
                      "open", {"row": f"#{n}"})
            resp = self.call(f"opened #{n} · plan: answer rows=#{n}", "answer", {"rows": f"#{n}"})
            self.outcome.append("done")
            return False
        elif tgt and tgt.mode == "name" and a.trashed:
            name = " ".join(tgt.words)       # search does not see the trash: the selector says it
        elif tgt and tgt.mode == "name":
            fam_any = self.st.familiar(tgt.words, None)
            if not fam_any:
                # §8.3 unfamiliar name -> search first
                think = self.kind_line(a, [], f'search first ("{tgt.phrase}" not seen)')
                self.call(self.first("\n".join(pre_lines + [think])), "search", {"text": " ".join(tgt.words)})
                pre_lines = []
                hits, binned = [], []
                for r in (self.steps[-1].effect or {}).get("rows", []):
                    m = self.model.by_id(r["id"])
                    (binned if m and m.trashed else hits).append(RowView(r["n"], r["kind"], m.name if m else "?"))
                kinds = (a.kind or "").split(",")
                binned_same = [h for h in binned if h.kind in kinds
                               and all(t in set(words(h.name)) for w in tgt.words for t in words(w))]
                if binned_same and not [h for h in hits if h.kind in kinds
                                        and all(t in set(words(h.name)) for w in tgt.words for t in words(w))]:
                    rows_b = ", ".join(f"#{h.n}" for h in binned_same)
                    if a.tool == "act":
                        self.call(f"search: only {' · '.join(short(h) for h in binned_same)} (in the trash); the person did"
                                  " not ask to restore · plan: decline not_found", "decline", {"reason": "not_found"})
                        self.outcome.append("trashed_only")
                        return False
                    if not a.op:
                        self.call(f"search: only {' · '.join(short(h) for h in binned_same)} (in the trash)"
                                  f" · plan: answer rows={rows_b}", "answer", {"rows": rows_b})
                        self.outcome.append("recover_trashed")
                        return False
                if not hits:
                    self.call(f'dead end: search "{" ".join(tgt.words)}" found nothing · plan: decline not_found',
                              "decline", {"reason": "not_found"})
                    self.outcome.append("not_found")
                    return False
                kinds = (a.kind or "").split(",")
                same = [h for h in hits if h.kind in kinds and all(t in set(words(h.name)) for w in tgt.words for t in words(w))]
                other = [h for h in hits if h.kind not in kinds and all(t in set(words(h.name)) for w in tgt.words for t in words(w))]
                if same:
                    pre_lines.append("seen: " + " · ".join(short(h) for h in same[:4]))
                    name = " ".join(tgt.words)
                elif other:
                    return self.other_kind(a, other, ref_n, more, pre_lines)
                else:
                    # typo / partial spelling: the words do not name the row; pick by number (§3 pick)
                    keys = set(tgt.keys)
                    ver, picked = [], []
                    for h in hits[:6]:
                        k = self.key_of_n(h.n)
                        ok = k in keys and h.kind in kinds
                        why = "" if ok else (f" (a {h.kind})" if h.kind not in kinds else " (other name)")
                        ver.append(f'#{h.n} {h.kind} "{h.name}" {"✓" if ok else "✗"}{why}')
                        if ok:
                            picked.append(h.n)
                    if not picked:
                        self.call(f"check: {' · '.join(ver)} · plan: decline not_found", "decline", {"reason": "not_found"})
                        self.outcome.append("not_found")
                        return False
                    rows = ", ".join(f"#{n}" for n in picked)
                    pre_lines.append(f"check: {' · '.join(ver)}")
                    plan_note = f"{a.tool} rows={rows} (a near spelling of the name)"
                    self.outcome.append("pick_typo")
            else:
                same = self.st.familiar(tgt.words, a.kind)
                live = [v for v in same if not self.binned(v)]
                if same and not live and a.tool in ("act", "answer") and a.verb != "restore":
                    rows_b = ", ".join(f"#{v.n}" for v in same)
                    if a.tool == "act":
                        self.call(self.first(f"seen: {' · '.join(short(v) for v in same)} only in the trash; the person did"
                                             " not ask to restore · plan: decline not_found"), "decline", {"reason": "not_found"})
                        self.outcome.append("trashed_only")
                        return False
                    if not a.op and all(v.n in self.st.addressable() for v in same):
                        self.call(self.first(f"seen: {' · '.join(short(v) for v in same)} (in the trash)"
                                             f" · plan: answer rows={rows_b}"), "answer", {"rows": rows_b})
                        self.outcome.append("recover_trashed")
                        return False
                if same:
                    name = " ".join(tgt.words)
                    vis = self.st.visible_matches(tgt.words, a.kind)
                    if vis:
                        src = "vault block" if all(v.n in self.st.preground for v in vis) else (
                            "directory" if all(v.n in self.st.directory for v in vis) else "shown")
                        pre_lines.insert(0, f"seen: {' · '.join(short(v) for v in vis[:4])} ({src})")
                else:
                    # seen only as another kind: look first with the stated kind (§4.1 two-step is for looking)
                    seen_as = sorted({v.kind for v in self.st.familiar(tgt.words, None)})
                    think = self.kind_line(a, ["name ~ " + " ".join(tgt.words)],
                                           f'find first ("{tgt.phrase}" seen only as {", ".join(seen_as)})')
                    r = self.call(self.first("\n".join(pre_lines + [think])), "find",
                                  {"kind": a.kind, "name": " ".join(tgt.words)})
                    eff = r.get("effect") or {}
                    txt = r.get("text", "")
                    if eff.get("rows"):
                        found = [RowView(x["n"], x["kind"], (self.model.by_id(x["id"]).name if self.model.by_id(x["id"]) else "?"))
                                 for x in eff["rows"]]
                        if a.tool == "act" and len(found) >= 2:
                            return self.ambiguous(a, found, [], ref_n, more, " ".join(tgt.words), after=True)
                        rows = f"#{found[0].n}" if len(found) == 1 else eff.get("result")
                        pre_lines = [f"found: {' · '.join(short(f) for f in found[:4])}"]
                        plan_note = f"{a.tool} rows={rows}"
                    elif "Other kinds" in txt:
                        other = [RowView(int(n), k, nm) for n, k, nm in ROW_RX.findall(txt.split("Other kinds", 1)[-1])]
                        return self.recover_other(a, other, ref_n, more)
                    else:
                        raise GenError("find-first empty without offers")
            # §8.6 ambiguity visible before a single-row write or a balance: ask, or pick when settled
            if name and ((a.tool == "act" and not a.bulk and a.verb != "create") or (a.op == "balance" and a.kind == "person")):
                vis = self.st.visible_matches(tgt.words, a.kind)
                if len(vis) >= 2:
                    return self.ambiguous(a, vis, pre_lines, ref_n, more, name)
        elif tgt and tgt.mode == "pick":
            return self.pick(a, pre_lines, ref_n, more)
        elif tgt and tgt.mode == "rows_kept":
            ns = [self.n_of_key(k) for k in tgt.keys]
            if any(n is None for n in ns):
                raise GenError("kept row not addressable")
            rows = ", ".join(f"#{n}" for n in ns)
            vis = [self.st.addressable()[n] for n in ns]
            pre_lines.append(f"settled: {tgt.pick_why} → " + " · ".join(short(v) for v in vis))
            plan_note = plan_note or f"{a.tool} rows={rows}" + (f" ({a.verb})" if a.verb else "")

        if a.bulk:
            conds = self.conds_of(a, tgt.words if tgt and name else None, ref_n)
            think = self.kind_line(a, conds, "find first (several rows meant), then act on the result")
            fa = self.selector(a, name, ref_n)
            r = self.call(self.first("\n".join(pre_lines + [think])), "find", fa)
            eff = r.get("effect") or {}
            if not eff.get("rows"):
                raise GenError("bulk find empty")
            handle = eff.get("result")
            rows = f"#{eff['rows'][0]['n']}" if len(eff["rows"]) == 1 else handle
            pre_lines = [f"found: {handle} · {len(eff['rows'])} rows, all meant"]
            plan_note = f"act {a.verb} on {rows}"
            name = None
            ref_n = {k: v for k, v in ref_n.items() if k != "linked_to"}

        conds = self.conds_of(a, tgt.words if (tgt and name) else None, ref_n)
        tool, args = self.main_args(a, name, ref_n, rows, more)
        plan = plan_note or self.plan_text(a, more)
        think = self.kind_line(a, conds if not rows else [], plan)
        resp = self.call(self.first("\n".join(pre_lines + [think])), tool, args)
        return self.react(a, resp, ref_n, more, name)

    def binned(self, rv: RowView) -> bool:
        for rid, n in self.st.id_n.items():
            if n == rv.n:
                m = self.model.by_id(rid)
                return bool(m and m.trashed)
        return False

    def other_kind(self, a: Action, other: list, ref_n: dict, more: bool, pre_lines: list) -> bool:
        """The name fits rows of another kind than the one said: take them (§8.5 recovery rows)."""
        rows = ", ".join(f"#{o.n}" for o in other)
        kinds = {o.kind for o in other}
        ver = " · ".join(f"{short(o)} ✓ (a {o.kind}, not a {a.kind})" for o in other)
        if a.tool == "act" and not all(a.verb in VERBS_BY_KIND.get(k, ()) for k in kinds):
            self.call(self.first("\n".join(pre_lines + [f"check: {ver} · {a.verb} does not apply · plan: decline not_found"])),
                      "decline", {"reason": "not_found"})
            self.outcome.append("not_found")
            return False
        if a.tool == "act":
            args = {"verb": a.verb, "rows": rows}
            aa = self.act_args(a, ref_n)
            if aa:
                args["args"] = aa
            if more:
                args["more"] = True
            tool = "act"
        else:
            tool, args = self.main_args(a, None, ref_n, rows, more)
        resp = self.call(self.first("\n".join(pre_lines + [f"check: {ver} · plan: {tool} rows={rows}"])), tool, args)
        self.outcome.append("recover_kind")
        return self.react(a, resp, ref_n, more, None)

    def plan_text(self, a: Action, more: bool) -> str:
        if a.tool == "act":
            s = f"act {a.verb}" + (" (more: another call follows)" if more else "")
            return s
        if a.tool == "compute":
            return f"compute {a.op} by {a.group}, then answer value"
        if a.op:
            return f"answer {a.op}" + (f" of {a.field_}" if a.field_ else "") + " (selector is enough)"
        return "answer (selector is enough)"

    def react(self, a: Action, resp: dict, ref_n: dict, more: bool, name: str | None) -> bool:
        eff = resp.get("effect") or {}
        text = resp.get("text", "")
        if eff.get("ambiguous"):
            cands = []
            for c in eff["ambiguous"]:
                m = self.model.by_id(c["id"])
                cands.append(RowView(c["n"], c["kind"], m.name if m else "?"))
            return self.ambiguous(a, cands, ["runtime: ambiguous"], ref_n, more, name, after=True)
        if eff.get("recovery") == "empty" and resp.get("ends_turn"):
            self.outcome.append("empty_answer")        # older runtimes ended the turn on an empty answer
            return False
        if eff.get("recovery") == "empty":
            if "trashed:" in text and "Other kinds" not in text:
                trashed = [RowView(int(n), k, nm) for n, k, nm in ROW_RX.findall(text.split("trashed:", 1)[-1])]
                if a.tool == "act" and a.verb != "restore":
                    self.call("dead end: only a trashed row fits; the person did not ask to restore"
                              " · plan: decline not_found", "decline", {"reason": "not_found"})
                    self.outcome.append("trashed_only")
                    return False
                if a.tool == "answer" and trashed and not a.op:
                    rows = ", ".join(f"#{t.n}" for t in trashed)
                    self.call(f"dead end: no live row; the runtime offers {' · '.join(short(t) for t in trashed)} "
                              f"(in the trash) · plan: answer rows={rows}", "answer", {"rows": rows})
                    self.outcome.append("recover_trashed")
                    return False
            other = [RowView(int(n), k, nm) for n, k, nm in ROW_RX.findall(text.split("Other kinds", 1)[-1])] \
                if "Other kinds" in text else []
            if other:
                return self.recover_other(a, other, ref_n, more)
            if name:
                # §8.5 nothing by that name: search it once
                self.call(f'dead end: 0 rows called "{name}" · plan: search "{name}"', "search", {"text": name})
                hits = (self.steps[-1].effect or {}).get("rows", [])
                if not hits:
                    self.call("search found nothing · plan: decline not_found", "decline", {"reason": "not_found"})
                    self.outcome.append("not_found")
                    return False
                raise GenError("dead end with search hits: scenario not designed for it")
            # a condition nothing meets: there is no name to search
            self.call("0 rows meet the conditions; nothing to search · plan: decline not_found",
                      "decline", {"reason": "not_found"})
            self.outcome.append("empty_decline")
            return False
        if eff.get("recovery") == "no_link":
            ms = [RowView(int(n), k, nm) for n, k, nm in ROW_RX.findall(text)]
            nums = re.findall(r"#(\d+)", text.split("mentions", 1)[-1]) if "mentions" in text else []
            if nums and a.tool == "answer":
                rows = ", ".join(f"#{n}" for n in nums)
                self.call(f"no link: runtime offers rows whose name mentions it · plan: answer rows={rows}",
                          "answer", {"rows": rows})
                self.outcome.append("recover_no_link")
                return False
            self.call("no link and nothing mentions it · plan: decline not_found", "decline", {"reason": "not_found"})
            self.outcome.append("not_found")
            return False
        if eff.get("already") and not resp.get("ends_turn") and not more:
            al = eff["already"]
            rows = ", ".join(f"#{x['n']}" for x in al)
            states = " · ".join(f"#{x['n']} {x.get('state', '')}".strip() for x in al)
            self.outcome.append("already")
            self.call(f"already so: {states}; nothing changed · plan: answer rows={rows} (state it)", "answer", {"rows": rows})
            return False
        if eff.get("already"):
            self.outcome.append("already")
        if a.tool == "compute" and eff.get("result"):
            self.call(f"computed {eff['result']} (one number per {a.group}) · plan: answer value={eff['result']}",
                      "answer", {"value": eff["result"]})
            self.outcome.append("done")
            return False
        if resp.get("ends_turn"):
            if a.tool == "answer" and not a.op and (eff.get("answer") or {}).get("rows") == []:
                self.outcome.append("empty_answer")
            self.outcome.append("done")
            return False
        return True

    def recover_other(self, a: Action, other: list[RowView], ref_n: dict, more: bool) -> bool:
        rows = ", ".join(f"#{o.n}" for o in other)
        kinds = {o.kind for o in other}
        if a.tool == "act":
            if all(a.verb in VERBS_BY_KIND.get(k, ()) for k in kinds):
                args = {"verb": a.verb, "rows": rows}
                aa = self.act_args(a, ref_n)
                if aa:
                    args["args"] = aa
                if more:
                    args["more"] = True
                think = (f"dead end: no {a.kind} by that name; runtime offers {' · '.join(short(o) for o in other)} ✓"
                         f" · plan: act {a.verb} rows={rows}")
                resp = self.call(think, "act", args)
                self.outcome.append("recover_kind")
                return self.react(a, resp, ref_n, more, None)
            self.call(f"dead end: offered {' · '.join(short(o) for o in other)} but {a.verb} does not apply"
                      " · plan: decline not_found", "decline", {"reason": "not_found"})
            self.outcome.append("not_found")
            return False
        args = {"rows": rows}
        if a.op:
            args = {"op": a.op, "rows": rows}
            if a.field_:
                args = {"op": a.op, "field": a.field_, "rows": rows}
        think = (f"dead end: no {a.kind} by that name; runtime offers {' · '.join(short(o) for o in other)} ✓"
                 f" · plan: {a.tool} rows={rows}")
        resp = self.call(think, a.tool, args)
        self.outcome.append("recover_kind")
        return self.react(a, resp, ref_n, more, None)

    def ambiguous(self, a: Action, cands: list[RowView], pre: list[str], ref_n: dict, more: bool,
                  name: str | None, after: bool = False) -> bool:
        req = self.req
        cands = sorted(cands, key=lambda c: c.n)
        who = ", ".join(short(c) for c in cands)
        if req.settle:
            sn = self.n_of_key(req.settle)
            if sn is None or sn not in [c.n for c in cands]:
                raise GenError("settle key not among candidates")
            ver = []
            for c in cands:
                ok = c.n == sn
                ver.append(f'#{c.n} "{c.name}" {"✓" if ok else "✗"}')
            head = (f'ambiguous: "{name}" fits {len(cands)} · ' if after else "") + f"check: {' · '.join(ver)}"
            tool, args = self.main_args(a, None, ref_n, f"#{sn}", more)
            resp = self.call(self.first("\n".join([p for p in pre if p != "runtime: ambiguous"] + [head + f" · plan: {tool} rows=#{sn}"])),
                             tool, args)
            self.outcome.append("settled_pick")
            return self.react(a, resp, ref_n, more, None)
        q = self.req.slots.get("_question") or f"Which {a.kind} do you mean: " + " or ".join(f'"{c.name}"' for c in cands) + "?"
        head = f'ambiguous: "{name}" fits {who}' if after else f'"{name}" fits {who}'
        self.call(self.first("\n".join([p for p in pre if p != "runtime: ambiguous" and not p.startswith("seen:")]
                                       + [head + " · the message does not decide · plan: ask"])),
                  "ask", {"question": q, "options": ", ".join(f"#{c.n}" for c in cands)})
        self.outcome.append("ask_after_ambiguous" if after else "ask")
        return False

    def pick(self, a: Action, pre: list[str], ref_n: dict, more: bool) -> bool:
        tgt = a.target
        look = tgt.look or {}
        cands: list[RowView] = []
        if look:
            think = self.kind_line(a, [], f"{look['tool']} first, then pick ({tgt.pick_why})")
            r = self.call(self.first("\n".join(pre + [think])), look["tool"], look["args"])
            for x in (r.get("effect") or {}).get("rows", [])[:12]:
                m = self.model.by_id(x["id"])
                cands.append(RowView(x["n"], x["kind"], m.name if m else "?"))
            pre = []
        else:
            raise GenError("pick without look")
        keys = set(tgt.keys)
        ver, picked = [], []
        for c in cands:
            k = self.key_of_n(c.n)
            ok = k in keys
            ver.append(f'#{c.n} {c.kind} "{c.name}" {"✓" if ok else "✗"}')
            if ok:
                picked.append(c.n)
        if not picked:
            raise GenError("pick target not shown")
        rows = ", ".join(f"#{n}" for n in picked)
        tool, args = self.main_args(a, None, ref_n, rows, more)
        think = f"check: {' · '.join(ver)} · plan: {tool} rows={rows}"
        resp = self.call(think, tool, args)
        self.outcome.append("pick")
        return self.react(a, resp, ref_n, more, None)
