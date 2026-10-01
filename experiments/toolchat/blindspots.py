"""Label every dev-90 turn by failure cause, by parsed tree against gold.

    python3 blindspots.py out/v3-dev90.stream.jsonl

Causes, first match wins: exact / invalid / date / literal / structure.
For structure misses the construct diff (in gold, missing from the model;
in the model, not in gold) is tallied, which is what names the groups."""
import collections, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "..", "crates", "evalsuite", "grammar"))
import check
from heldout_check import constructs, strip_lits, lits

gold = {}
for t in json.load(open(os.path.join(HERE, "..", "..", "crates", "evalsuite", "grammar", "map.json")))["turns"]:
    if t["corpus"] == "suite":
        gold[(t["session"], t["turn"])] = t
cause = collections.Counter(); bycat = collections.defaultdict(collections.Counter)
miss, extra = collections.Counter(), collections.Counter()
examples = collections.defaultdict(list)
for line in open(sys.argv[1]):
    r = json.loads(line); g = gold[(r["session"], r["turn"])]
    m = r.get("raw_text", r.get("raw", "")).strip().split("\n")[0] if r.get("gbnf_valid", r.get("valid", True)) else ""
    gt = check.parse(g["canonical"])
    try: mt = check.parse(m) if m else None
    except check.ParseError: mt = None
    if mt is None: c = "invalid"
    elif mt == gt: c = "exact"
    elif strip_lits(mt) == strip_lits(gt):
        pairs = list(zip(lits(gt), lits(mt)))
        c = "date" if any(x[0] in ("date", "datetime") and x != y for x, y in pairs) else "literal"
    else:
        c = "structure"
        gc, mc = constructs(gt), constructs(mt)
        for k in (gc - mc): miss[k] += 1; examples["miss " + k].append((g["request"], m, g["canonical"]))
        for k in (mc - gc): extra[k] += 1
    cause[c] += 1; bycat[g["category"]][c] += 1
n = sum(cause.values())
print("turns %d" % n)
for k, v in cause.most_common(): print("  %-10s %4d  %5.1f%%" % (k, v, 100 * v / n))
cs = ["exact", "structure", "literal", "date", "invalid"]
print("\n%-24s " % "category" + " ".join("%9s" % c for c in cs))
for cat, cc in sorted(bycat.items(), key=lambda x: -sum(x[1].values())):
    print("%-24s " % cat + " ".join("%9d" % cc[c] for c in cs))
print("\nstructure misses: constructs gold has and the model lacks (top 25)")
for k, v in miss.most_common(25): print("  %3d  %s" % (v, k))
print("\nstructure misses: constructs the model added that gold lacks (top 15)")
for k, v in extra.most_common(15): print("  %3d  %s" % (v, k))
if len(sys.argv) > 2:
    with open(sys.argv[2], "w") as fh:
        json.dump({k: v[:4] for k, v in examples.items()}, fh, indent=1)
