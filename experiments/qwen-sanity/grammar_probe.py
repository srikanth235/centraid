"""Does the decoder enforce what the SCHEMA says, or only part of it?

    python3 grammar_probe.py          # needs a llama-server on :8080

A JSON schema is not the constraint.  The constraint is whatever
`llama.cpp`'s JSON-schema-to-GBNF converter builds out of it, and that
converter is LOSSY: measured on b217f81c266, it **silently ignores
`pattern`**.  A slot typed `{"type": "string", "pattern":
"^\\d{4}-\\d{2}-\\d{2}$"}`, asked for the word banana, generated

    {"v": "banana. The person is asking about what they owe. ..."}

which a real JSON-Schema validator rejects.  So "illegal output is impossible
by construction" is true of STRUCTURE -- which keys exist, which enums a
string is drawn from, how many items an array holds, which branch of a
discriminated union applies -- and FALSE of STRING SHAPE.  The schema proofs
in `mkschema.py` use a real validator and therefore cannot see this: the
schema is right and the converter drops part of it.

This file is the minimal reproduction, kept runnable so that a later
`llama.cpp` which DOES honour `pattern` is DETECTED rather than assumed.  Run
it against whatever server the sweep is using; it takes one generation.

WHAT IS SAFE AND WHAT IS NOT, as of this measurement:

  * enums, `required`, `additionalProperties: false`, `minItems`/`maxItems`,
    `anyOf` branches, `$ref` -- all enforced.  Everything `mkschema.py`
    depends on for legality is in this set, by design.
  * `format: date` and `format: date-time` -- enforced; the converter builds a
    real rule for them.
  * `pattern` -- NOT enforced.  `month`, `daterange`, `duration` and a number
    carried as text have no `format`, so their shape is advisory: the pattern
    documents the contract and catches a bad frame on the way back in, which
    is worth having and is not the same as preventing it.

THE DESIGN CONSEQUENCE, for whoever reads this next: on `llama.cpp`, put every
constraint you actually depend on into STRUCTURE -- enums, required keys,
arity, discriminated branches -- and treat a regex as advisory.  Where a
value's shape matters and no `format` covers it, the options are an enum if
the space is small enough, a structural decomposition (a date as three integer
fields rather than one patterned string), or post-decode validation that
COUNTS a violation as a failure.  Repairing the output is not one of the
options.
"""

from __future__ import annotations

import json
import re
import sys
import urllib.request

ENDPOINT = "http://127.0.0.1:8080/v1/chat/completions"

PROBES = [
    ("pattern", {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$"},
     re.compile(r"^\d{4}-\d{2}-\d{2}$")),
    ("format:date", {"type": "string", "format": "date"},
     re.compile(r"^\d{4}-\d{2}-\d{2}$")),
    ("enum", {"type": "string", "enum": ["alpha", "beta"]},
     re.compile(r"^(alpha|beta)$")),
]

ASK = "Put the word banana in v."


def probe(name, slot, expected):
    schema = {"type": "object", "properties": {"v": slot},
              "required": ["v"], "additionalProperties": False}
    body = {"messages": [{"role": "user", "content": ASK}],
            "response_format": {"type": "json_schema", "json_schema": {
                "name": "probe", "schema": schema, "strict": True}},
            "temperature": 0, "top_k": 1, "max_tokens": 48}
    request = urllib.request.Request(
        ENDPOINT, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=600) as fh:
        reply = json.load(fh)
    text = reply["choices"][0]["message"].get("content") or ""
    try:
        value = json.loads(text).get("v")
    except Exception:
        return name, False, "not JSON: %s" % " ".join(text.split())[:60]
    held = bool(expected.match(str(value)))
    return name, held, " ".join(str(value).split())[:60]


def main():
    print("%-14s %-9s %s" % ("constraint", "enforced", "what came back"))
    failures = 0
    for name, slot, expected in PROBES:
        name, held, got = probe(name, slot, expected)
        print("%-14s %-9s %s" % (name, "YES" if held else "no", got))
        if name == "pattern" and held:
            print("\n  `pattern` IS enforced by this build. The note in "
                  "mkschema.py and in this file's docstring is out of date "
                  "for it -- re-check which value slots can rely on a regex.")
        if name != "pattern" and not held:
            failures += 1
            print("\n  %s is NOT enforced, and mkschema.py depends on it. "
                  "Every number taken under this build is suspect." % name)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
