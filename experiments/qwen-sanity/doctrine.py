"""The instruction block, read out of the GENERATED `Doctrine.swift`.

`gen_vocab.py` writes `Sources/afm-spike/Doctrine.swift` from the grammar's
`lexicon.py` and `derive/derived.json`; `gen_vocab.py --check` fails when it is
stale.  This lane uses the SAME text as its system prompt rather than a second
copy, so the two spikes are measured against one instruction block.
"""

from __future__ import annotations

import ast
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
SWIFT = os.path.normpath(os.path.join(
    HERE, "..", "afm-spike", "Sources", "afm-spike", "Doctrine.swift"))

_STRING = re.compile(r'^\s*("(?:[^"\\]|\\.)*")\s*,\s*$')


def text():
    body = open(SWIFT, encoding="utf-8").read()
    start = body.index("public static let text")
    lines = []
    for line in body[start:].splitlines():
        match = _STRING.match(line)
        if match:
            lines.append(ast.literal_eval(match.group(1)))
        elif "].joined(separator:" in line:
            break
    if not lines:
        raise RuntimeError("no instruction lines found in %s" % SWIFT)
    return "\n".join(lines)


if __name__ == "__main__":
    out = text()
    print(out)
    print("---- %d chars, %d words" % (len(out), len(out.split())))
