# -*- coding: utf-8 -*-
"""Project a training file onto the shape `overlap-check` reads."""
import json
import sys

with open(sys.argv[2], "w") as out:
    for line in open(sys.argv[1]):
        row = json.loads(line)
        out.write(json.dumps({"request": row["input"].split(" ||| ", 1)[1],
                              "template_id": row["template_id"]}) + "\n")
