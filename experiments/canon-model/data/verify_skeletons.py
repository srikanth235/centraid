"""Every skeleton must parse under the grammar's own parser (check.py)."""
import json, os, re, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "crates", "evalsuite", "grammar"))
import check

DUMMY = {
    "PERSON": "Ondrej Vasquez", "PLACE": "Skerrit Point", "GROUP": "Flat 7B",
    "TASK": "Re-grout the shower", "EVENT": "Boiler service",
    "EVENT1": "check-in", "EVENT2": "check-out",
    "NOTE": "Boiler fault codes", "DOC": "Boiler warranty 2026",
    "PHOTO": "Gulls over the spit", "ALBUM": "Allotment year",
    "EXPENSE": "Grit for the path", "LOCKER": "Rowing club members area",
    "DATELABEL": "anniversary", "CHANNEL": "07700 900123",
    "ACTIVITY": "call", "REASON": "train fare", "FOLDER": "Household",
    "NOTEBOOK": "Household", "CATEGORY": "supplies", "USERNAME": "o.vasquez",
    "MONTHDAY": "03-14",
    "DATE": "2026-06-19", "DATETIME": "2026-06-19T14:00", "MONTH": "2026-06",
    "RANGE": "2026-06-16..2026-06-19", "NUM": "30", "SMALL": "2",
    "AMOUNT": "1200", "EFFORT": "45", "CADENCE": "30", "DURATION": "+1d",
}

def fill(text):
    return re.sub(r"\{([A-Z0-9]+)\}", lambda m: DUMMY[m.group(1)], text)

def main():
    here = os.path.dirname(os.path.abspath(__file__))
    rows = json.load(open(os.path.join(here, "skeletons.json")))
    bad = []
    for row in rows:
        text = fill(row["canonical"])
        try:
            check.parse(text)
        except check.ParseError as error:
            bad.append((row["skel_id"], row["family"], str(error), text))
    print("skeletons checked : %d" % len(rows))
    print("parse failures    : %d" % len(bad))
    for item in bad[:15]:
        print("  FAIL %s %s\n    %s\n    %s" % item)
    return 1 if bad else 0

if __name__ == "__main__":
    sys.exit(main())
