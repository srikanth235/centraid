"""Canonicals for executor commands the distilled corpus never teaches.

Every name comes from the invented second world (distill_world.py) or from
the lists below; nothing is read from the evaluation suite. Argument names
are exactly the ones `crates/candidates/src/exec.rs` reads for each command.
"""
import datetime, json, os, random, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "canon-model", "data"))
sys.path.insert(0, os.path.join(HERE, ".."))
import distill_world as W
import gbnf

rng = random.Random(11)
TODAY = datetime.date(2027, 2, 13)
TASK_NEW = ["Renew the allotment permit", "Collect the reframed print",
            "Descale the kettle", "Return the borrowed ladder",
            "Sharpen the hedge shears", "Post the co-op ballot",
            "Clean the kiln shelves", "Swap the winter tyres",
            "Measure the hallway for a runner", "Oil the gate hinges",
            "Sort the seed tins", "Recycle the old paint pots",
            "Book the chimney sweep", "Label the freezer drawers",
            "Check the loft insulation"]
NOTE_NEW = ["Gate hinge sizes", "Seed tin inventory", "Chimney sweep quotes",
            "Runner measurements", "Paint colours for the landing",
            "Loft insulation depths", "Tyre pressures", "Cello practice plan"]
KINDS_OF_CONTACT = ["call", "visit", "message", "coffee"]


def day():
    return TODAY + datetime.timedelta(days=rng.randint(1, 40))


def stamp():
    d = day().isoformat()
    return d if rng.random() < 0.6 else d + "T" + rng.choice(["08:30", "14:30", "18:00", "11:00"])


def person():
    return rng.choice(W.PEOPLE) if rng.random() < 0.6 else "%s %s" % (
        rng.choice(W.FIRST), rng.choice(W.LAST))


tasks = []
def add(prev, target):
    tasks.append({"id": "nc%04d" % len(tasks), "prev": prev, "target": target})

titles = W.TASK_TITLES + TASK_NEW
for _ in range(30):
    add("NONE", 'schedule.add_task{ title: "%s", due_at: %s }' % (rng.choice(titles), stamp()))
for _ in range(10):
    add("NONE", 'schedule.add_task{ title: "%s" }' % rng.choice(titles))
for _ in range(10):
    L = rng.choice(W.LOCKER_TITLES)
    add('show locker items called "%s"' % L,
        'locker.reveal_receipt{ columns: "%s" } on it' % rng.choice(["password", "password", "username"]))
for _ in range(10):
    add("NONE", 'locker.reveal_receipt{ columns: "%s" } on (locker items called "%s")'
        % (rng.choice(["password", "password", "username"]), rng.choice(W.LOCKER_TITLES)))
for _ in range(20):
    add("NONE", 'people.log_interaction{ kind: "%s" } on (parties called "%s")'
        % (rng.choice(KINDS_OF_CONTACT), person()))
for _ in range(10):
    add('show parties called "%s"' % person(),
        'people.log_interaction{ kind: "%s" } on it' % rng.choice(KINDS_OF_CONTACT))
for _ in range(12):
    add("NONE", 'knowledge.create_note{ title: "%s" }' % rng.choice(W.NOTE_TITLES + NOTE_NEW))
for _ in range(16):
    add("NONE", 'tally.add_group_member{ group_id: (groups called "%s") } on (parties called "%s")'
        % (rng.choice(W.GROUPS + W.TRIPS), person()))
for _ in range(12):
    payer = "me" if rng.random() < 0.6 else '(parties called "%s")' % person()
    add("NONE", 'tally.settle_up{ group_id: (groups called "%s"), from_party: %s, amount_minor: %d }'
        % (rng.choice(W.GROUPS + W.TRIPS), payer, rng.choice([500, 1250, 2000, 4575, 900])))
for _ in range(15):
    add("NONE", 'show first 1 of (activities of (parties called "%s") ordered by started_at desc)' % person())
for _ in range(5):
    add('show parties called "%s"' % person(),
        'show first 1 of (activities of it ordered by started_at desc)')
for _ in range(5):
    add("NONE", 'show first 1 of (expenses ordered by spent_on desc)')
for _ in range(5):
    add("NONE", 'show first 1 of (tasks that (status != "completed") ordered by due_at asc)')

rec = gbnf.Recognizer(gbnf.rules())
bad = [t["target"] for t in tasks if not rec.full(t["target"])]
assert not bad, bad
seen, uniq = set(), []
for t in tasks:
    if (t["prev"], t["target"]) not in seen:
        seen.add((t["prev"], t["target"])); uniq.append(t)
for i in range(0, len(uniq), 40):
    json.dump(uniq[i:i + 40], open(os.path.join(HERE, "batches", "b%02d.json" % (i // 40)), "w"), indent=1)
print(len(uniq), "tasks")
