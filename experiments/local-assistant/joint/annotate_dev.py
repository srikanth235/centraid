"""Add span annotations to the selector lane's hand-written dev paraphrases.

``selector/dev_paraphrase.jsonl`` is hand-written held-out text: wordings no
template produced, labelled by hand. The joint model needs slot supervision on
it too, so this script proposes a span for every slot of the labelled
operation, by locating the synthetic world's own vocabulary (people, albums,
folders, date phrases …) inside the request, and ``PATCH`` carries the rows
where the proposal was wrong or a slot has no lexical anchor — those were read
and fixed by hand, which is what makes this a dev set rather than more
generated data.

    python3 joint/annotate_dev.py --write     # -> joint/dev_joint.jsonl
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "selector"))
sys.path.insert(0, str(HERE))

import annotate as A  # noqa: E402
import world_synthetic as W  # noqa: E402

SOURCE = ROOT / "selector" / "dev_paraphrase.jsonl"
OUT = HERE / "dev_joint.jsonl"

# Vocabulary that can anchor a span, longest first so "Fiona Albright" wins
# over "Fiona".
VOCABULARY: dict[str, list[str]] = {
    "person": W.PEOPLE + W.FIRST_NAMES,
    "people": W.PEOPLE + W.FIRST_NAMES,
    "name": W.PEOPLE + W.FIRST_NAMES,
    "attendees": W.PEOPLE + W.FIRST_NAMES,
    "company": W.COMPANIES,
    "event": W.EVENTS,
    "topic": W.EVENTS + W.TOPICS + W.DOC_TOPICS,
    "project": W.PROJECTS,
    "album": W.ALBUMS,
    "notebook": W.NOTEBOOKS,
    "folder": W.FOLDERS,
    "group": W.GROUPS,
    "place": W.PLACES,
    "task": W.TASK_TITLES,
    "title": W.TASK_TITLES + W.EVENTS,
    "service": W.SERVICES,
    "note": W.NOTE_TITLES,
    "docs": W.DOC_TOPICS,
    "window": W.WINDOWS + W.DUE_WINDOWS + W.DATES,
    "day": W.WINDOWS + W.DUE_WINDOWS + W.DATES,
    "due": W.DUE_WINDOWS + W.DATES + W.WINDOWS,
    "when": W.TIMES + W.DATES + W.WINDOWS,
    "description": W.EXPENSES,
    "amount": W.AMOUNTS,
}

# Hand corrections, keyed by request text: the slots this row really carries.
# ``{}`` means the proposal was right; a dict replaces the proposal entirely.
PATCH: dict[str, dict[str, object]] = {
    "whats my week look like": {"spans": {"window": "my week"}},
    "hey, am I busy on saturday at all?": {"spans": {"window": "saturday"}},
    "diary for next month please": {"spans": {"window": "next month"}},
    "i forget the date of the hiring panel": {"spans": {"topic": "hiring panel"}},
    "is my day packed on thursday": {"spans": {"day": "thursday"}},
    "anything i should know about tomorrow, tasks and all": {"spans": {"day": "tomorrow"}},
    "whats overdue then": {"spans": {"window": "overdue"}},
    "nothing slipping is there": {"spans": {"window": "overdue"}},
    "clear the chimney sweep one": {"spans": {"task": "the chimney sweep one"}},
    "i sorted the printer ink thing": {"spans": {"task": "the printer ink thing"}},
    "who's my contact over at baxtel again": {"spans": {"company": "baxtel"}},
    "anyone i know works at larkspur?": {"spans": {"company": "larkspur"}},
    "which of my passwords are rubbish": {"spans": {}, "enums": {"reason": "weak"}},
    "anything of mine turn up in a leak": {"spans": {}, "enums": {"reason": "breached"}},
    "do i still owe anyone": {"spans": {}, "enums": {"direction": "i_owe"}},
    "is anyone behind on paying me back": {"spans": {}, "enums": {"direction": "owed_to_me"}},
    "stick a pottery class on friday evening": {"spans": {"title": "pottery class", "when": "friday evening"}},
    "i need a supplier call with Dmitri next tuesday at 11": {"spans": {"title": "supplier call", "when": "next tuesday at 11", "attendees": "Dmitri"}},
    "new meeting please: board prep, monday morning": {"spans": {"title": "board prep", "when": "monday morning"}},
    "can the vendor sync happen on wednesday instead": {"spans": {"event": "vendor sync", "when": "wednesday"}},
    "slide the hiring panel an hour later": {"spans": {"event": "hiring panel", "when": "an hour later"}},
    "the launch party moved, make it the 30th": {"spans": {"event": "launch party", "when": "the 30th"}},
    "add two more people to the launch party: Theo and Nadia": {"spans": {"event": "launch party", "people": "Theo and Nadia"}},
    "anything i'm late on?": {"spans": {}},
    "which tasks are sitting with the Baxtel lot": {"spans": {"people": "the Baxtel lot"}},
    "watered the plants, cross it off": {"spans": {"task": "watered the plants"}},
    "the parking permit one is sorted": {"spans": {"task": "the parking permit one"}},
    "close out the chimney sweep task": {"spans": {"task": "the chimney sweep task"}},
    "the invoice task can wait until next month": {"spans": {"task": "the invoice task", "due": "next month"}},
    "new deadline for the router return: friday": {"spans": {"task": "the router return", "due": "friday"}},
    "put back the printer ink one by a week": {"spans": {"task": "the printer ink one", "due": "a week"}},
    "let Mei take the chimney sweep task": {"spans": {"task": "the chimney sweep task", "people": "Mei"}},
    "hand the invoice job to Rafael": {"spans": {"task": "the invoice job", "people": "Rafael"}},
    "Sam owns the parking permit one now": {"spans": {"task": "the parking permit one", "people": "Sam"}},
    "search contacts: Bittencourt": {"spans": {"name": "Bittencourt"}},
    "on Clara's record, write that she's vegetarian": {"spans": {"person": "Clara", "body": "she's vegetarian"}},
    "remember Theo hates phone calls": {"spans": {"person": "Theo", "body": "hates phone calls"}},
    "add to Fiona's profile: moving to Oslo in spring": {"spans": {"person": "Fiona", "body": "moving to Oslo in spring"}},
    "anything written down about the Northwind people": {"spans": {"people": "the Northwind people"}},
    "note to self: the boiler service is due in march": {"spans": {"title": "the boiler service is due in march"}},
    "start a note in Research about shipping rates": {"spans": {"notebook": "Research", "title": "shipping rates"}},
    "write down that Mei recommended a good electrician": {"spans": {"title": "Mei recommended a good electrician"}},
    "tack onto the boiler quote note: they want cash": {"spans": {"note": "the boiler quote", "body": "they want cash"}},
    "update the supplier call notes with the new price": {"spans": {"note": "the supplier call notes", "body": "the new price"}},
    "find me shots of the Larkspur crowd": {"spans": {"people": "the Larkspur crowd"}},
    "pictures i took in august": {"spans": {"window": "august"}},
    "camera roll from last weekend": {"spans": {"window": "last weekend"}},
    "what did i shoot on the 14th": {"spans": {"window": "the 14th"}},
    "drop those into Balcony": {"spans": {"photos": "those", "album": "Balcony"}},
    "file the Jaipur ones under Roadtrip": {"spans": {"photos": "the Jaipur ones", "album": "Roadtrip"}},
    "add these pictures to the Summit 2027 album": {"spans": {"photos": "these pictures", "album": "Summit 2027"}},
    "favourite everything in Invoices": {"spans": {"docs": "everything in Invoices"}},
    "which of my logins are dodgy": {"spans": {}, "enums": {"reason": "weak"}},
    "store my new Driftshare password": {"spans": {"service": "Driftshare"}, "enums": {"kind": "login"}},
    "save Hollowmail credentials in the locker": {"spans": {"service": "Hollowmail"}, "enums": {"kind": "login"}},
    "add a locker entry for Zenbank": {"spans": {"service": "Zenbank"}, "enums": {"kind": "login"}},
    "net me out against the Vertigo Labs lot": {"spans": {"people": "the Vertigo Labs lot"}},
    "anyone still owe me?": {"spans": {}, "enums": {"direction": "owed_to_me"}},
    "who am i in debt to": {"spans": {}, "enums": {"direction": "i_owe"}},
    "list outstanding balances in my favour": {"spans": {}, "enums": {"direction": "owed_to_me"}},
    "i paid 90 for the ferry tickets, split it with Yusuf": {"spans": {"description": "the ferry tickets", "people": "Yusuf", "amount": "90"}},
    "add groceries 55 to the Housemates group": {"spans": {"description": "groceries", "group": "Housemates", "amount": "55"}},
    "new shared expense: the cabin, 600, me and Ingrid": {"spans": {"description": "the cabin", "people": "Ingrid", "amount": "600"}},
    "and november?": {"spans": {"window": "november"}},
    "narrow that down to last month": {"spans": {"people": "that", "window": "last month"}},
    "first ones done, tick it": {"spans": {"task": "first ones"}},
    "shove the bottom one out to december": {"spans": {"task": "the bottom one", "due": "december"}},
    "flag number two": {"spans": {"docs": "number two"}},
    "put the first two in the Pets album": {"spans": {"photos": "the first two", "album": "Pets"}},
    "note that i dropped the bottom one an email": {"spans": {"person": "the bottom one"}, "enums": {"channel": "email"}},
    "do any of them owe me anything": {"spans": {"people": "them"}},
}

WORD = re.compile(r"\b")


def propose(request: str, label: str) -> tuple[dict[str, str], dict[str, str]]:
    lowered = request.lower()
    spans: dict[str, str] = {}
    enums: dict[str, str] = {}
    for slot, spec in A.PARAMS.get(label, {}).items():
        if slot in A.ENUM_SLOTS:
            for value in spec.get("enum", []):
                if value != "any" and re.search(rf"\b{re.escape(value)}", lowered):
                    enums[slot] = value
                    break
            continue
        best = ""
        for candidate in sorted(VOCABULARY.get(slot, []), key=len, reverse=True):
            if candidate.lower() in lowered and len(candidate) > len(best):
                best = candidate
        if best:
            start = lowered.index(best.lower())
            spans[slot] = request[start : start + len(best)]
    return spans, enums


def build() -> list[dict]:
    rows = []
    for line in SOURCE.read_text().splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        request, label = str(row["request"]), str(row["label"])
        spans, enums = propose(request, label)
        patch = PATCH.get(request)
        if patch is not None:
            spans = dict(patch.get("spans") or {})  # type: ignore[arg-type]
            enums = dict(patch.get("enums") or enums)  # type: ignore[arg-type]
        located = []
        for slot, text in spans.items():
            start = request.lower().find(text.lower())
            if start < 0:
                raise SystemExit(f"patched span {text!r} is not in {request!r}")
            located.append({"slot": slot, "text": request[start : start + len(text)], "start": start, "end": start + len(text)})
        rows.append(
            {
                "request": request,
                "previous_request": row.get("previous_request"),
                "previous_operation": row.get("previous_operation"),
                "label": label,
                "spans": located,
                "enums": enums,
                "kind": "dev",
            }
        )
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--show", action="store_true")
    args = parser.parse_args()
    rows = build()
    annotated = [r for r in rows if r["spans"] or r["enums"]]
    print(f"{len(rows)} dev rows, {len(annotated)} carry slot annotations")
    if args.show:
        for row in rows:
            print(f"{row['label']:22s} {row['request']!r} -> {[(s['slot'], s['text']) for s in row['spans']]} {row['enums']}")
    if args.write:
        with OUT.open("w") as handle:
            for row in rows:
                handle.write(json.dumps(row) + "\n")
        print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
