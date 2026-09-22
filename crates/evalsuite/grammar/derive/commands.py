"""The typed command registry, read out of `crates/vault/src/commands/*.rs`.

There is no machine-readable manifest of the registry — a `CommandDefinition`
is Rust, its input schema is a JSON Schema embedded as a raw string, and its
EFFECT is whatever SQL its handler runs. So this reads the source: for each
`fn …() -> CommandDefinition` body it takes the command's name, its input
schema, its gates, and the SQL statements in the body. The SQL is what makes an
effect class derivable at all (see `derive_grammar.py`); everything else the
registry states outright.

What this CANNOT read is recorded as a finding rather than guessed: the
registry declares no egress side-effect and no subject kind, and both are
inferred here from the handler's SQL and the input schema's own FK-shaped
argument names.
"""

from __future__ import annotations

import json
import os
import re

FILES = (
    "core",
    "core_links",
    "knowledge",
    "locker",
    "media",
    "people",
    "schedule",
    "social",
    "tally",
)

_FN = re.compile(r"\n(?:pub )?fn (\w+)\(\)\s*->\s*CommandDefinition\s*\{")
_NAME = re.compile(r'"((?:core|knowledge|locker|media|people|schedule|social|tally)\.[a-z_0-9]+)"')
_RAW = re.compile(r'r#"(.*?)"#', re.S)
_SQL = re.compile(
    r'"((?:INSERT|UPDATE|DELETE|SELECT)\s[^"]*?)"',
    re.S | re.I,
)


class Command:
    __slots__ = ("name", "schema", "required", "properties", "sql", "risk",
                 "confirm", "idempotency", "sealed_input", "online_only", "source")

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "required": self.required,
            "properties": self.properties,
            "risk": self.risk,
            "confirm": self.confirm,
            "idempotency": self.idempotency,
            "sealedInput": self.sealed_input,
            "onlineOnly": self.online_only,
            "writes": sorted(self.writes()),
            "reads": sorted(self.reads()),
            "source": self.source,
        }

    def writes(self) -> set[str]:
        """Physical tables this handler INSERTs, UPDATEs or DELETEs."""
        found = set()
        for statement in self.sql:
            for match in re.finditer(
                r"\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+(\w+)",
                statement,
                re.I,
            ):
                found.add(match.group(1))
        return found

    def reads(self) -> set[str]:
        found = set()
        for statement in self.sql:
            for match in re.finditer(r"\bFROM\s+(\w+)", statement, re.I):
                found.add(match.group(1))
        return found - self.writes()

    def sets_column(self, column: str) -> bool:
        """True when a handler statement assigns `column` to a non-NULL value."""
        for statement in self.sql:
            for match in re.finditer(
                rf"\b{column}\s*=\s*(\?\d*|'[^']*'|\w+\()", statement, re.I
            ):
                if match.group(1):
                    return True
        return False

    def clears_column(self, column: str) -> bool:
        return any(
            re.search(rf"\b{column}\s*=\s*NULL", statement, re.I)
            for statement in self.sql
        )


def _extract_bodies(text: str) -> list[tuple[str, str]]:
    bodies = []
    for match in _FN.finditer(text):
        start = match.end()
        depth, index = 1, start
        while index < len(text) and depth:
            if text[index] == "{":
                depth += 1
            elif text[index] == "}":
                depth -= 1
            index += 1
        bodies.append((match.group(1), text[start : index - 1]))
    return bodies


def load(root: str) -> list[Command]:
    """Every registered command, in registry order per file."""
    out: list[Command] = []
    seen: set[str] = set()
    src = os.path.join(root, "crates", "vault", "src", "commands")
    for stem in FILES:
        path = os.path.join(src, f"{stem}.rs")
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
        # Only the names the file's own `definitions()` returns are registered;
        # a helper that happens to quote a command name is not a command.
        # A schema may arrive as a `const NAME: &str = r#"…"#` or as a
        # nullary `macro_rules!` that expands to one. Both are resolved here
        # so an arg shape is derivable for every command and not only for the
        # ones whose author inlined it.
        aliases: dict[str, str] = {}
        for const in re.finditer(
            r'(?:const|static)\s+(\w+)\s*:\s*&(?:\'static\s+)?str\s*=\s*r#"(.*?)"#', text, re.S
        ):
            aliases[const.group(1)] = const.group(2)
        for mac in re.finditer(
            r'macro_rules!\s+(\w+)\s*\{\s*\(\)\s*=>\s*\{\s*r#"(.*?)"#', text, re.S
        ):
            aliases[mac.group(1) + "!()"] = mac.group(2)

        # `const SEALED_ITEM_CELLS: [&str; 16] = ["password", …];` — the
        # sealed-input lists locker assigns by name rather than inlining.
        const_arrays: dict[str, str] = {
            m.group(1): m.group(2)
            for m in re.finditer(
                r"(?:const|static)\s+(\w+)\s*:\s*\[&(?:'static\s+)?str;[^\]]*\]\s*=\s*\[(.*?)\];",
                text,
                re.S,
            )
        }

        registered = set()
        listing = re.search(r"fn definitions\(\)\s*->\s*Vec<CommandDefinition>\s*\{(.*?)\n\}", text, re.S)
        if listing:
            registered = set(re.findall(r"(\w+)\(\)", listing.group(1)))
        for fn_name, body in _extract_bodies(text):
            if registered and fn_name not in registered:
                continue
            name_match = _NAME.search(body)
            if not name_match:
                continue
            command = Command()
            command.name = name_match.group(1)
            if command.name in seen:
                continue
            seen.add(command.name)
            command.source = f"crates/vault/src/commands/{stem}.rs"
            schema = None
            alias = re.search(r"input_schema:\s*(\w+)\s*,", body) or re.search(
                r'"[a-z_]+\.[a-z_0-9]+"\s*,\s*(\w+!?\(?\)?)\s*,', body
            )
            if alias:
                key = alias.group(1)
                text_schema = aliases.get(key) or aliases.get(key + "!()")
                if text_schema:
                    try:
                        schema = json.loads(text_schema.strip())
                    except json.JSONDecodeError:
                        schema = None
            if schema is None:
                # `concat!(r#"…"#, CONST, r#"…"#)`: one schema assembled from
                # fragments. Joining them is the only way to see the args of
                # the seven commands whose authors split the schema up.
                for cat in re.finditer(r"concat!\((.*?)\n\s*\)", body, re.S):
                    pieces = []
                    for token in re.finditer(r'r#"(.*?)"#|\b([A-Z][A-Z_0-9]*)\b', cat.group(1), re.S):
                        pieces.append(
                            token.group(1) if token.group(1) is not None
                            else aliases.get(token.group(2), "")
                        )
                    joined = "".join(pieces).strip()
                    if joined.startswith("{"):
                        try:
                            schema = json.loads(joined)
                        except json.JSONDecodeError:
                            schema = None
                        if schema is not None:
                            break
            for raw in _RAW.finditer(body):
                if schema is not None:
                    break
                candidate = raw.group(1).strip()
                if candidate.startswith("{"):
                    try:
                        schema = json.loads(candidate)
                    except json.JSONDecodeError:
                        schema = None
                    if schema is not None and "properties" in schema:
                        break
                    schema = None
            command.schema = schema or {}
            command.required = list(command.schema.get("required", []))
            command.properties = {
                key: (value.get("type") if isinstance(value, dict) else None)
                for key, value in command.schema.get("properties", {}).items()
            }
            command.sql = [m.group(1) for m in _SQL.finditer(body)]
            risk = re.search(r"Risk::(\w+)", body)
            command.risk = risk.group(1).lower() if risk else None
            idem = re.search(r"Idempotency::(\w+)", body)
            command.idempotency = idem.group(1).lower() if idem else None
            command.confirm = (
                ".parks()" in body
                or re.search(r"confirm:\s*true", body) is not None
            )
            # Both idioms: the field set in the literal, and the field assigned
            # afterwards on a definition the file's own helper built. The
            # second is what locker and tally use, and reading only the first
            # made every one of the nine `online_only` commands — and every
            # sealed input — invisible to the derivation.
            command.online_only = (
                re.search(r"online_only:\s*true", body) is not None
                or re.search(r"\.online_only\s*=\s*true", body) is not None
                or ".online()" in body
            )
            sealed = re.search(
                r"sealed_input:\s*&\[([^\]]*)\]|\.sealed_input\s*=\s*&\[([^\]]*)\]",
                body,
            )
            if sealed:
                command.sealed_input = re.findall(
                    r'"(\w+)"', sealed.group(1) or sealed.group(2) or ""
                )
            else:
                named = re.search(r"\.sealed_input\s*=\s*&([A-Z][A-Z_0-9]*)", body)
                command.sealed_input = (
                    re.findall(r'"(\w+)"', const_arrays.get(named.group(1), ""))
                    if named
                    else []
                )
            out.append(command)
    return out


_DECLARED = re.compile(
    r"Declared(Effect|Egress)\s*\{\s*command:\s*\"([^\"]+)\"\s*,\s*"
    r"(?:effect|egress):\s*(?:Effect|Egress)::(\w+)\s*,\s*why:\s*\"(.*?)\"\s*,?\s*\}",
    re.S,
)


def load_declarations(root: str) -> tuple[dict, dict]:
    """`DECLARED_EFFECTS` and `DECLARED_EGRESS`, out of `commands/mod.rs`.

    The registry states in Rust what the handler's SQL cannot: the effect of
    the twenty-six commands whose write lives in a helper, and the egress of
    every command the structural signals raise. Both are read here so the
    derivation can hold them to the SQL and to the signals rather than taking
    either on trust.
    """
    path = os.path.join(root, "crates", "vault", "src", "commands", "mod.rs")
    with open(path, encoding="utf-8") as handle:
        text = handle.read()
    effects: dict[str, dict] = {}
    egress: dict[str, dict] = {}
    for kind, command, value, why in _DECLARED.findall(text):
        why = re.sub(r"\\\s*\n\s*", "", why).strip()
        target = effects if kind == "Effect" else egress
        target[command] = {
            "value": re.sub(r"(?<!^)(?=[A-Z])", "-", value).lower(),
            "why": why,
        }
    return effects, egress
