"""Round 2 canonicals: the idioms round 1 still missed, per GRAMMAR.md
(overdue = before now + open; due means open; R-X2; C14). Names come from the
invented world or from NAMES below, which excludes every name seen in the
evaluation suite."""
import json, os, random, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "..", "canon-model", "data"))
sys.path.insert(0, os.path.join(HERE, "..", ".."))
import distill_world as W, gbnf
rng = random.Random(21)
NAMES = ["Aarav Mehta", "Chloe Dubois", "Kenji Watanabe", "Fatima Haddad", "Lucas Silva",
         "Ingrid Berg", "Omar Farouk", "Sofia Russo", "Daniel Kim", "Amara Okafor",
         "Tomasz Nowak", "Leila Karimi", "Hugo Martin", "Mei Lin", "Diego Torres",
         "Anika Sharma", "Jonas Weber", "Grace Mwangi", "Pablo Ortega", "Yuki Sato",
         "Rohan Iyer", "Elena Popescu", "Samuel Osei", "Hannah Fischer", "Arjun Nair",
         "Lina Haddad", "Mateo Rossi", "Zara Ahmed", "Oscar Lindgren", "Maya Cohen"]
TITLES = ["Water the tomatoes", "Pay the parking fine", "Fix the squeaky hinge",
          "Book a haircut", "Back up the laptop", "Buy stamps", "Defrost the freezer",
          "Call the plumber", "Renew the car tax", "Send the thank-you cards"]
def person():
    r = rng.random()
    if r < 0.5: return rng.choice(NAMES)
    if r < 0.7: return rng.choice(NAMES).split()[0]
    return rng.choice(W.PEOPLE)
WINDOWS = ["this week", "today", "tomorrow", "next week", "this weekend", "this month"]
tasks = []
def add(prev, target): tasks.append({"id": "r2_%04d" % len(tasks), "prev": prev, "target": target})
for _ in range(6):
    add("NONE", 'show tasks that (due_at during before now and status != "completed")')
for w in WINDOWS:
    add("NONE", 'show tasks that (due_at during %s and status != "completed")' % w)
for _ in range(4):
    add("NONE", 'count of tasks that (due_at during before now and status != "completed")')
for _ in range(10):
    g = rng.choice(W.GROUPS + W.TRIPS)
    add('show expenses of (groups called "%s")' % g, "sum amount_minor of them")
for _ in range(6):
    add('show obligations of (parties called "%s") that (settled_at is null)' % person(), "sum amount_minor of it")
for _ in range(5):
    add('show expenses of (groups called "%s")' % rng.choice(W.GROUPS), "count of them")
for _ in range(12):
    add("NONE", 'show obligations of (parties called "%s") that (settled_at is null)' % person())
for _ in range(8):
    p = person()
    add('show first 1 of (activities of (parties called "%s") ordered by started_at desc)' % p,
        'show obligations of (parties called "%s") that (settled_at is null)' % p)
for _ in range(6):
    p1, p2 = person(), person()
    add('sum amount_minor of (obligations of (parties called "%s") that (settled_at is null))' % p1,
        'sum amount_minor of (obligations of (parties called "%s") that (settled_at is null))' % p2)
for _ in range(15):
    add("NONE", 'show first 1 of (activities of (parties called "%s") ordered by started_at desc)' % person())
for _ in range(15):
    add("NONE", 'show parties called "%s"' % person())
for _ in range(8):
    t = rng.choice(TITLES + W.TASK_TITLES)
    word = rng.choice(t.split()[1:3])
    add("NONE", 'show tasks called "%s" ordered by due_at asc' % word.lower())
for _ in range(6):
    add("NONE", 'people.log_interaction{ kind: "call" } on (parties called "%s")' % rng.choice(NAMES))
for _ in range(6):
    add("NONE", 'schedule.add_task{ title: "%s" }' % rng.choice(TITLES))
rec = gbnf.Recognizer(gbnf.rules())
assert all(rec.full(t["target"]) and (t["prev"] == "NONE" or rec.full(t["prev"])) for t in tasks)
seen, uniq = set(), []
for t in tasks:
    k = (t["prev"], t["target"])
    if k not in seen: seen.add(k); uniq.append(t)
for i in range(0, len(uniq), 35):
    json.dump(uniq[i:i + 35], open(os.path.join(HERE, "batches", "b%02d.json" % (i // 35)), "w"), indent=1)
print(len(uniq), "tasks")
