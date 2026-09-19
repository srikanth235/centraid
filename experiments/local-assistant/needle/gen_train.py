"""Training-data generator for the Needle 3 slot filler.

Shape matches deployment (brief, "train for the shape you deploy"):
  * 1-4 tools shown: the target operation + its catalogue siblings, sometimes
    one cross-app distractor.
  * multi-turn: ~half the samples carry a prior user turn, the prior tool call,
    and a <tool_result> feedback turn before the target turn.
  * follow-up turns use anaphora ("those people", "the first one") and the
    convention that phrase slots are passed through VERBATIM for the code-side
    resolvers, never resolved by the model.
  * a slice of "no tool applies" samples whose target is an empty call list.

Synthetic world is deliberately disjoint from the evaluation world: different
names, companies, projects, events, places.

Whole-template holdout: every utterance carries a template id; `--holdout`
moves a fraction of template ids (not rows) into the val file.

Output rows are in the `needle finetune` JSONL format:
    {"system":..., "tools":[...], "query":..., "reasoning":..., "answers":[...]}
Multi-turn is expressed inside `query` with the model's own chat markers, so
the stock renderer in needle.model.finetune.render_example produces the full
conversation and the loss mask still covers only the final assistant call.
"""

from __future__ import annotations

import argparse
import json
import random
import re

SYSTEM = "date: 2026-09-19 Sat 09:00"

IM_END = "<|im_end|>"
IM_START = "<|im_start|>"
TOOL_CALL_START, TOOL_CALL_END = "<tool_call>", "</tool_call>"
TOOL_RESULT_START, TOOL_RESULT_END = "<tool_result>", "</tool_result>"

# ------------------------------------------------------------------ world

POOLS: dict[str, list] = {
    "window": ["this week", "next week", "tomorrow", "today", "this month",
               "next month", "the next ten days", "last weekend", "2026-11-03"],
    "window2": ["last summer", "the week after", "August", "the last fortnight"],
    "day": ["Wednesday", "Monday", "the 14th", "Friday", "the day after tomorrow"],
    "when": ["Tuesday at 9", "next Thursday morning", "the 21st at noon",
             "Friday afternoon", "Monday at 3"],
    "due": ["Friday", "next Tuesday", "the end of the month", "in three days",
            "2026-10-09"],
    "topic": ["the grant renewal", "the sprinkler repair", "the tariff review",
              "the warehouse move", "the Meridian rollout", "onboarding"],
    "project": ["Meridian", "Fjord", "Saffron", "Lantern", "Bluewater"],
    "person": ["Ines", "Theo", "Rina", "Obi", "Clara", "Yusuf"],
    "fullname": ["Ines Duarte", "Theo Halvorsen", "Rina Matsuda",
                 "Obi Nwachukwu", "Clara Bergstrom", "Yusuf Demir"],
    "company": ["Verdant Labs", "Northwind Freight", "Halcyon Bank",
                "Prairie Optics", "Kestrel Foods"],
    "event": ["the quarterly roadmap", "the vendor sync", "the onboarding huddle",
              "the budget walkthrough", "the safety drill"],
    "title": ["order the replacement filters", "book the rehearsal room",
              "chase the shipping quote", "draft the handover note"],
    "eventtitle": ["a supplier call", "a physio appointment", "a site visit",
                   "a handover meeting"],
    "notebook": ["Fieldwork", "Recipes", "Reading", "Workshop"],
    "notetitle": ["greenhouse layout ideas", "supplier shortlist",
                  "winter travel plan", "workshop wiring"],
    "album": ["Alps 2025", "Garden", "Harbour trip", "Studio"],
    "place": ["Osaka", "Reykjavik", "Porto", "Kandy"],
    "group": ["the ski cabin", "the flatmates", "the Porto trip", "the boat fund"],
    "service": ["Aurora Bank", "Trellis Mail", "Ridgeline VPN", "Casserole"],
    "folder": ["Contracts", "Invoices 2026", "Warranty", "Shipping"],
    "doc": ["the supplier contract", "the boiler warranty", "the freight invoice"],
    "task": ["order the replacement filters", "chase the shipping quote",
             "book the rehearsal room"],
    "note": ["the greenhouse layout ideas note", "the supplier shortlist note"],
    "body": ["prefers email over calls", "sent the revised quote on Monday",
             "wants the samples before the review"],
    "amount": [45, 120, 860, 1975, 32],
    "expense": ["the taxi", "groceries", "the ferry tickets", "the studio rental"],
    "calendar": ["work", "personal", "family"],
    "kind": ["pdf", "sheet", "doc", "image"],
    "lockerkind": ["login", "card", "note", "identity"],
    "status": ["open", "done"],
    "direction": ["owed_to_me", "i_owe"],
    "reason": ["reused", "weak", "breached"],
    "section": ["channels", "dates", "relationships"],
    "channel": ["call", "email", "message", "met"],
}

# ------------------------------------------------------------- templates
# (template id, utterance, {slot: value-expression})
# Value expressions are format strings over the same binding, so a slot can be
# a sub-phrase of the utterance ("{topic}") or a fixed enum value.

T: dict[str, list[tuple[str, str, dict]]] = {
    "agenda_upcoming": [
        ("a", "what is on my calendar {window}", {"window": "{window}"}),
        ("b", "anything scheduled {window}", {"window": "{window}"}),
        ("c", "show my {calendar} calendar for {window}",
         {"window": "{window}", "calendar": "{calendar}"}),
    ],
    "agenda_search": [
        ("a", "when is {event}", {"topic": "{event_bare}"}),
        ("b", "find {event} on my calendar", {"topic": "{event_bare}"}),
        ("c", "is {event} {window}", {"topic": "{event_bare}", "window": "{window}"}),
    ],
    "agenda_day_context": [
        ("a", "how does {day} look", {"day": "{day}"}),
        ("b", "walk me through {day}", {"day": "{day}"}),
        ("c", "what does my {day} look like", {"day": "{day}"}),
    ],
    "people_at": [
        ("a", "who was at {event}", {"event": "{event_bare}"}),
        ("b", "who is coming to {event}", {"event": "{event_bare}"}),
        ("c", "who declined {event}", {"event": "{event_bare}", "response": "declined"}),
    ],
    "agenda_create_event": [
        ("a", "put {eventtitle} on {when}",
         {"title": "{eventtitle_bare}", "when": "{when}"}),
        ("b", "schedule {eventtitle} for {when} with {person}",
         {"title": "{eventtitle_bare}", "when": "{when}", "attendees": "{person}"}),
        ("c", "book {eventtitle} {when}", {"title": "{eventtitle_bare}", "when": "{when}"}),
    ],
    "agenda_reschedule": [
        ("a", "move {event} to {when}", {"event": "{event_bare}", "when": "{when}"}),
        ("b", "push {event} to {when}", {"event": "{event_bare}", "when": "{when}"}),
    ],
    "agenda_cancel_event": [
        ("a", "cancel {event}", {"event": "{event_bare}"}),
        ("b", "drop {event} from my calendar", {"event": "{event_bare}"}),
    ],
    "agenda_attendee_add": [
        ("a", "add {person} to {event}", {"event": "{event_bare}", "people": "{person}"}),
        ("b", "invite {person} to {event}", {"event": "{event_bare}", "people": "{person}"}),
    ],
    "tasks_due": [
        ("a", "what is due {window}", {"window": "{window}"}),
        ("b", "tasks due {window}", {"window": "{window}"}),
        ("c", "what do I need to finish {window}", {"window": "{window}"}),
    ],
    "tasks_about": [
        ("a", "what tasks are about {topic}", {"topic": "{topic_bare}"}),
        ("b", "anything on my list for {topic}", {"topic": "{topic_bare}"}),
        ("c", "tasks mentioning {topic}", {"topic": "{topic_bare}"}),
    ],
    "tasks_by_project": [
        ("a", "list the tasks in {project}", {"project": "{project}"}),
        ("b", "what is left on {project}", {"project": "{project}"}),
        ("c", "show the {status} tasks in {project}",
         {"project": "{project}", "status": "{status}"}),
    ],
    "tasks_for_people": [
        ("a", "what is {person} working on", {"people": "{person}"}),
        ("b", "what is assigned to {person}", {"people": "{person}"}),
        ("c", "tasks owned by {person}", {"people": "{person}"}),
    ],
    "tasks_add": [
        ("a", "add a task to {title}", {"title": "{title}"}),
        ("b", "remind me to {title} by {due}", {"title": "{title}", "due": "{due}"}),
        ("c", "new task {title} in {project}", {"title": "{title}", "project": "{project}"}),
    ],
    "tasks_complete": [
        ("a", "mark {task} as done", {"task": "{task}"}),
        ("b", "tick off {task}", {"task": "{task}"}),
    ],
    "tasks_set_due": [
        ("a", "move {task} to {due}", {"task": "{task}", "due": "{due}"}),
        ("b", "make {task} due {due}", {"task": "{task}", "due": "{due}"}),
    ],
    "tasks_assign": [
        ("a", "give {task} to {person}", {"task": "{task}", "people": "{person}"}),
        ("b", "assign {task} to {person}", {"task": "{task}", "people": "{person}"}),
    ],
    "people_find": [
        ("a", "find the contact for {fullname}", {"name": "{fullname}"}),
        ("b", "look up {fullname}", {"name": "{fullname}"}),
        ("c", "find {fullname} at {company}", {"name": "{fullname}", "company": "{company}"}),
    ],
    "people_profile": [
        ("a", "open {person}'s profile", {"person": "{person}"}),
        ("b", "show me everything about {person}", {"person": "{person}", "section": "all"}),
        ("c", "what are {person}'s {section}", {"person": "{person}", "section": "{section}"}),
    ],
    "people_at_company": [
        ("a", "who do I know at {company}", {"company": "{company}"}),
        ("b", "list my contacts at {company}", {"company": "{company}"}),
    ],
    "people_add": [
        ("a", "add {fullname} to my contacts", {"name": "{fullname}"}),
        ("b", "save {fullname} from {company}", {"name": "{fullname}", "company": "{company}"}),
    ],
    "people_log_interaction": [
        ("a", "log that I {channel_past} {person} {window}",
         {"person": "{person}", "when": "{window}", "channel": "{channel}"}),
        ("b", "note that I {channel_past} {person}",
         {"person": "{person}", "channel": "{channel}"}),
    ],
    "people_add_note": [
        ("a", "add a note to {person}: {body}", {"person": "{person}", "body": "{body}"}),
        ("b", "on {person}'s record write that {body}",
         {"person": "{person}", "body": "{body}"}),
    ],
    "notes_search": [
        ("a", "find my notes about {topic}", {"topic": "{topic_bare}"}),
        ("b", "search the notes for {topic}", {"topic": "{topic_bare}"}),
    ],
    "notes_in_notebook": [
        ("a", "what is in my {notebook} notebook", {"notebook": "{notebook}"}),
        ("b", "show the {notebook} notes from {window}",
         {"notebook": "{notebook}", "window": "{window}"}),
    ],
    "notes_about_people": [
        ("a", "what notes mention {person}", {"people": "{person}"}),
        ("b", "notes about {person}", {"people": "{person}"}),
    ],
    "notes_create": [
        ("a", "start a note called {notetitle}", {"title": "{notetitle}"}),
        ("b", "new note {notetitle} in {notebook}",
         {"title": "{notetitle}", "notebook": "{notebook}"}),
    ],
    "notes_append": [
        ("a", "add to {note}: {body}", {"note": "{note_bare}", "body": "{body}"}),
        ("b", "append {body} to {note}", {"note": "{note_bare}", "body": "{body}"}),
    ],
    "photos_of_people": [
        ("a", "show me photos of {person}", {"people": "{person}"}),
        ("b", "pictures with {person} from {window}",
         {"people": "{person}", "window": "{window}"}),
    ],
    "photos_by_date": [
        ("a", "photos from {window}", {"window": "{window}"}),
        ("b", "what did I shoot {window}", {"window": "{window}"}),
    ],
    "photos_in_album": [
        ("a", "open the {album} album", {"album": "{album}"}),
        ("b", "show the {album} album", {"album": "{album}"}),
    ],
    "photos_at_place": [
        ("a", "photos taken in {place}", {"place": "{place}"}),
        ("b", "pictures from {place} {window}", {"place": "{place}", "window": "{window}"}),
    ],
    "photos_add_to_album": [
        ("a", "put those photos in the {album} album",
         {"photos": "those photos", "album": "{album}"}),
    ],
    "docs_search": [
        ("a", "find {doc}", {"topic": "{doc_bare}"}),
        ("b", "find the {kind} for {doc}", {"topic": "{doc_bare}", "kind": "{kind}"}),
    ],
    "docs_in_folder": [
        ("a", "what is in the {folder} folder", {"folder": "{folder}"}),
        ("b", "open {folder}", {"folder": "{folder}"}),
    ],
    "docs_star": [
        ("a", "star {doc}", {"docs": "{doc_bare}"}),
        ("b", "flag {doc} as important", {"docs": "{doc_bare}"}),
    ],
    "docs_move": [
        ("a", "move {doc} into {folder}", {"docs": "{doc_bare}", "folder": "{folder}"}),
    ],
    "locker_find": [
        ("a", "what is my {service} password", {"service": "{service}", "kind": "login"}),
        ("b", "find the {service} entry", {"service": "{service}"}),
    ],
    "locker_weak": [
        ("a", "which passwords are {reason}", {"reason": "{reason}"}),
        ("b", "show me the {reason} logins", {"reason": "{reason}"}),
    ],
    "locker_add": [
        ("a", "save a {lockerkind} for {service}",
         {"service": "{service}", "kind": "{lockerkind}"}),
    ],
    "tally_balance_with": [
        ("a", "what is my balance with {person}", {"people": "{person}"}),
        ("b", "do I owe {person} anything", {"people": "{person}", "direction": "i_owe"}),
    ],
    "tally_who_owes_me": [
        ("a", "who owes me money", {"direction": "owed_to_me"}),
        ("b", "who am I in debt to", {"direction": "i_owe"}),
    ],
    "tally_group_balance": [
        ("a", "what is the balance in {group}", {"group": "{group_bare}"}),
        ("b", "how do we stand in {group}", {"group": "{group_bare}"}),
    ],
    "tally_expenses_with": [
        ("a", "show the expenses with {person}", {"people": "{person}"}),
        ("b", "what have {person} and I spent {window}",
         {"people": "{person}", "window": "{window}"}),
    ],
    "tally_add_expense": [
        ("a", "add {amount} for {expense} with {person}",
         {"description": "{expense_bare}", "amount": "#{amount}", "people": "{person}"}),
        ("b", "split {expense} {amount} with {person} in {group}",
         {"description": "{expense_bare}", "amount": "#{amount}", "people": "{person}",
          "group": "{group_bare}"}),
    ],
    "tally_settle_up": [
        ("a", "settle up with {person}", {"people": "{person}"}),
        ("b", "pay {person} back {amount}", {"people": "{person}", "amount": "#{amount}"}),
    ],
}

# Follow-up templates: used only as the FINAL turn of a multi-turn sample.
# The phrase slots must be passed through verbatim -- resolvers do the lookup.
FOLLOWUPS: dict[str, list[tuple[str, str, dict]]] = {
    "tally_balance_with": [
        ("f1", "do I owe any of them", {"people": "any of them", "direction": "i_owe"}),
        ("f2", "what is my balance with those people", {"people": "those people"}),
    ],
    "tasks_for_people": [
        ("f1", "what are they working on", {"people": "they"}),
        ("f2", "what is on their lists", {"people": "their"}),
    ],
    "notes_about_people": [
        ("f1", "any notes about them", {"people": "them"}),
    ],
    "photos_of_people": [
        ("f1", "photos of those people", {"people": "those people"}),
    ],
    "tasks_complete": [
        ("f1", "mark the first one done", {"task": "the first one"}),
        ("f2", "tick off the second one", {"task": "the second one"}),
    ],
    "tasks_set_due": [
        ("f1", "push the first one to {due}", {"task": "the first one", "due": "{due}"}),
    ],
    "agenda_attendee_add": [
        ("f1", "add {person} to it", {"event": "it", "people": "{person}"}),
    ],
    "agenda_upcoming": [
        ("f1", "how about {window2}", {"window": "{window2}"}),
    ],
    "tasks_due": [
        ("f1", "and {window2}", {"window": "{window2}"}),
    ],
    "photos_add_to_album": [
        ("f1", "put those in the {album} album",
         {"photos": "those", "album": "{album}"}),
    ],
    "docs_star": [
        ("f1", "star the first one", {"docs": "the first one"}),
    ],
    "tally_expenses_with": [
        ("f1", "show the expenses instead", {"people": "them"}),
    ],
}

NO_TOOL = [
    ("n1", "what is the weather in {place} right now"),
    ("n2", "tell me a joke"),
    ("n3", "how do I get to {place} from here"),
    ("n4", "translate good morning into Portuguese"),
    ("n5", "what is {amount} divided by seven"),
    ("n6", "write me a poem about {place}"),
]

CHANNEL_PAST = {"call": "called", "email": "emailed", "message": "messaged",
                "met": "met"}


# ------------------------------------------------------------- rendering


def bind(rng: random.Random) -> dict[str, object]:
    b = {key: rng.choice(values) for key, values in POOLS.items()}
    # "_bare" variants strip a leading article, so the slot value is the phrase
    # the resolver will look up rather than the surface determiner.
    for key in ("event", "topic", "group", "doc", "note", "expense", "eventtitle"):
        text = str(b[key])
        b[key + "_bare"] = re.sub(r"^(the|a|an)\s+", "", text)
    b["channel_past"] = CHANNEL_PAST[str(b["channel"])]
    return b


def fill(expr, b: dict) -> object:
    if isinstance(expr, str) and expr.startswith("#"):
        return b[expr[2:-1]] if expr[1] == "{" else expr[1:]
    return expr.format(**b)


def render_call(op: str, slots: dict, b: dict) -> dict:
    return {"name": op, "arguments": {k: fill(v, b) for k, v in slots.items()}}


def tool_schema(op: dict) -> dict:
    properties, required = {}, []
    for slot, spec in op.get("params", {}).items():
        node = {"type": spec.get("type", "string")}
        if spec.get("description"):
            node["description"] = spec["description"]
        if spec.get("enum"):
            node["enum"] = spec["enum"]
        properties[slot] = node
        if spec.get("required"):
            required.append(slot)
    return {"name": op["name"], "description": op["description"],
            "parameters": {"type": "object", "properties": properties,
                           "required": required}}


def fake_results(op_name: str, rng: random.Random, b: dict) -> list[dict]:
    if op_name.startswith("people"):
        return [{"name": b["fullname"]}, {"name": rng.choice(POOLS["fullname"])}]
    if op_name.startswith("tasks"):
        return [{"id": "t1", "title": b["title"]}, {"id": "t2", "title": b["task"]}]
    if op_name.startswith("agenda"):
        return [{"id": "e1", "title": b["event_bare"], "start": "2026-09-24T10:00"}]
    if op_name.startswith("photos"):
        return [{"id": "p1"}, {"id": "p2"}]
    if op_name.startswith("docs"):
        return [{"id": "d1", "title": b["doc_bare"]}]
    if op_name.startswith("tally"):
        return [{"person": b["person"], "net": -float(b["amount"])}]
    return [{"id": "x1", "title": b["notetitle"]}]


def compose_query(turns: list[dict], final: str) -> str:
    """Multi-turn query rendered with the model's own chat markers. The stock
    renderer wraps this in the user/assistant scaffolding, so the composed
    string turns one training row into a real conversation."""
    parts = []
    for turn in turns:
        parts.append(turn["request"])
        parts.append(IM_END + "\n" + IM_START + "assistant\n")
        parts.append(TOOL_CALL_START + json.dumps([turn["call"]], separators=(",", ":"))
                     + TOOL_CALL_END + IM_END + "\n")
        parts.append(IM_START + "user\n" + TOOL_RESULT_START
                     + json.dumps(turn["results"], separators=(",", ":"))
                     + TOOL_RESULT_END + IM_END + "\n" + IM_START + "user\n")
    parts.append(final)
    return "".join(parts)


def tools_for(catalogue: dict, target: str, rng: random.Random) -> list[dict]:
    names = [target] + [s for s in catalogue[target].get("siblings", []) if s in catalogue]
    names = names[:3]
    if rng.random() < 0.35:
        other = rng.choice([n for n in catalogue
                            if catalogue[n]["app"] != catalogue[target]["app"]])
        if other not in names:
            names.append(other)
    names = names[:4]
    rng.shuffle(names)
    return [tool_schema(catalogue[n]) for n in names]


def reasoning_for(call: dict) -> str:
    if not call:
        return "No tool covers this request."
    pairs = ", ".join(f"{k} <- '{v}'" for k, v in call["arguments"].items())
    return f"{call['name']}: {pairs or 'no arguments'}."


def make_sample(catalogue: dict, rng: random.Random) -> tuple[dict, str]:
    b = bind(rng)
    if rng.random() < 0.07:
        tid, text = rng.choice(NO_TOOL)
        target = rng.choice(list(catalogue))
        return ({"system": SYSTEM, "tools": tools_for(catalogue, target, rng),
                 "query": text.format(**b), "reasoning": reasoning_for({}),
                 "answers": []}, "none/" + tid)

    ops = [op for op in T if op in catalogue]
    target = rng.choice(ops)
    tools = tools_for(catalogue, target, rng)
    shown = [t["name"] for t in tools]
    multi = rng.random() < 0.45

    if multi and target in FOLLOWUPS and rng.random() < 0.6:
        tid, text, slots = rng.choice(FOLLOWUPS[target])
        template_id = f"{target}/{tid}"
    else:
        tid, text, slots = rng.choice(T[target])
        template_id = f"{target}/{tid}"

    call = render_call(target, slots, b)
    query = text.format(**b)

    turns = []
    if multi:
        prior_name = next((n for n in shown if n != target), None) or target
        prior_tid, prior_text, prior_slots = rng.choice(
            T.get(prior_name) or T[target])
        prior_op = prior_name if prior_name in T else target
        if not (prior_op == target and prior_tid == tid):
            turns.append({
                "request": prior_text.format(**b),
                "call": render_call(prior_op, prior_slots, b),
                "results": fake_results(prior_op, rng, b),
            })
            template_id = f"{prior_op}/{prior_tid}>{template_id}"

    return ({"system": SYSTEM, "tools": tools,
             "query": compose_query(turns, query),
             "reasoning": reasoning_for(call),
             "answers": [call]}, template_id)


# ------------------------------------------------------- overlap checker


def tokens(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", text.lower()))


def jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def forbidden_utterances(paths: list[str]) -> list[set[str]]:
    """Every utterance the training data must not paraphrase: suite cases, dev
    cases, and the catalogue's example_utterances (docs only, per Lane 1)."""
    out: list[set[str]] = []
    for path in paths:
        if path.endswith(".jsonl"):
            with open(path) as handle:
                for line in handle:
                    if not line.strip():
                        continue
                    row = json.loads(line)
                    for text in ([row.get("request")]
                                 + [t.get("request") for t in row.get("context", [])]):
                        if text:
                            out.append(tokens(text))
        else:
            with open(path) as handle:
                data = json.load(handle)
            for op in data.get("operations", data.get("cases", [])):
                for text in op.get("example_utterances", []) or []:
                    out.append(tokens(text))
                if op.get("request"):
                    out.append(tokens(op["request"]))
                for turn in op.get("turns", []) or []:
                    if turn.get("request"):
                        out.append(tokens(turn["request"]))
    return out


def overlaps(query: str, forbidden: list[set[str]], threshold: float) -> float:
    """Highest Jaccard against any forbidden utterance, per conversation turn."""
    worst = 0.0
    for turn in re.split(r"<\|im_start\|>user\n|<\|im_end\|>", query):
        turn = re.sub(r"<tool_(call|result)>.*?</tool_\1>", " ", turn, flags=re.S)
        turn = turn.replace("<|im_start|>assistant\n", " ").strip()
        if not turn:
            continue
        got = tokens(turn)
        for other in forbidden:
            worst = max(worst, jaccard(got, other))
            if worst > threshold:
                return worst
    return worst


# ------------------------------------------------------------------ main


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalogue", required=True)
    parser.add_argument("--n", type=int, default=1200)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--holdout", type=float, default=0.18,
                        help="fraction of TEMPLATE IDS held out for validation")
    parser.add_argument("--overlap-against", nargs="*", default=[],
                        help="suite.json / dev_cases.jsonl / catalogue.json")
    parser.add_argument("--overlap-threshold", type=float, default=0.8)
    parser.add_argument("--train-out", default="needle/data/train.jsonl")
    parser.add_argument("--val-out", default="needle/data/val.jsonl")
    args = parser.parse_args()

    with open(args.catalogue) as handle:
        catalogue = {op["name"]: op for op in json.load(handle)["operations"]}
    rng = random.Random(args.seed)
    forbidden = forbidden_utterances(args.overlap_against)

    # Whole-template holdout: split the leaf template ids, not the rows.
    leaves = sorted({f"{op}/{tid}" for op, rows in T.items() for tid, _, _ in rows}
                    | {f"{op}/{tid}" for op, rows in FOLLOWUPS.items()
                       for tid, _, _ in rows})
    rng.shuffle(leaves)
    held = set(leaves[:max(1, int(len(leaves) * args.holdout))])

    train, val, rejected = [], [], 0
    attempts = 0
    while len(train) + len(val) < args.n and attempts < args.n * 40:
        attempts += 1
        sample, template_id = make_sample(catalogue, rng)
        if overlaps(sample["query"], forbidden, args.overlap_threshold) > args.overlap_threshold:
            rejected += 1
            continue
        sample["template_id"] = template_id
        leaf = template_id.split(">")[-1]
        (val if leaf in held else train).append(sample)

    import os
    os.makedirs(os.path.dirname(args.train_out), exist_ok=True)
    for path, rows in ((args.train_out, train), (args.val_out, val)):
        with open(path, "w") as sink:
            for row in rows:
                sink.write(json.dumps(row) + "\n")
    print(json.dumps({
        "train": len(train), "val": len(val),
        "held_out_templates": sorted(held),
        "rejected_for_overlap": rejected,
        "overlap_threshold": args.overlap_threshold,
        "overlap_sources": args.overlap_against,
        "seed": args.seed,
    }, indent=2))


if __name__ == "__main__":
    main()
