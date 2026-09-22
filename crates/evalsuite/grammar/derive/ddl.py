"""A small SQLite-DDL reader for `contracts/schema/vault-ddl.sql`.

The fixture is GENERATED from the golden vault's `sqlite_master` (see
`crates/ontology/src/ddl.rs`), so it is the one language-neutral statement of
the vault's shape. Nothing here interprets: it reports columns, declared types,
`CHECK (col IN (...))` value sets, foreign keys and primary keys exactly as the
file spells them, and leaves every judgement to `derive_grammar.py`.

Stdlib only, on purpose — the derivation must be runnable without a cargo
build, or it would be a second thing that can rot.
"""

from __future__ import annotations

import re

# `-- <kind> <name> on <table>` headers separate the fixture's blocks.
_BLOCK = re.compile(r"^-- (\w+) (\S+) on (\S+)$", re.M)


def _strip_comments(text: str) -> str:
    return re.sub(r"--[^\n]*", "", text)


def _split_top_level(body: str) -> list[str]:
    """Split a CREATE TABLE body on commas that are not inside parentheses."""
    parts, depth, current = [], 0, []
    for ch in body:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append("".join(current))
            current = []
        else:
            current.append(ch)
    if "".join(current).strip():
        parts.append("".join(current))
    return [p.strip() for p in parts if p.strip()]


_TYPES = {"TEXT", "INTEGER", "REAL", "BLOB", "ANY", "NUMERIC"}

_CHECK_IN = re.compile(r"CHECK\s*\(\s*(\w+)\s+IN\s*\(([^)]*)\)\s*\)", re.I)
_REFERENCES = re.compile(r"REFERENCES\s+(\w+)\s*\(\s*(\w+)\s*\)", re.I)
_FK_CLAUSE = re.compile(
    r"FOREIGN\s+KEY\s*\(\s*([\w\s,]+?)\s*\)\s*REFERENCES\s+(\w+)\s*\(\s*([\w\s,]+?)\s*\)",
    re.I,
)
_PK_CLAUSE = re.compile(r"PRIMARY\s+KEY\s*\(\s*([\w\s,]+?)\s*\)", re.I)
_LITERALS = re.compile(r"'((?:[^']|'')*)'")
_ON_DELETE = re.compile(r"ON\s+DELETE\s+(CASCADE|RESTRICT|SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION)", re.I)


class Column:
    __slots__ = (
        "name", "type", "not_null", "check_values", "references", "primary_key",
        "on_delete",
    )

    def __init__(self, name: str, type_: str) -> None:
        self.name = name
        self.type = type_
        self.not_null = False
        self.check_values: list[str] | None = None
        self.references: tuple[str, str] | None = None
        self.primary_key = False
        # The FK's declared delete rule, upper-cased ("CASCADE", "SET NULL",
        # "RESTRICT", …), or None when the column carries no FK or the DDL
        # leaves the rule at SQLite's NO ACTION default. A CASCADE from a NOT
        # NULL column is the schema saying the row cannot outlive its parent,
        # which is what `derive_grammar.py`'s facet test reads.
        self.on_delete: str | None = None

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "type": self.type,
            "notNull": self.not_null,
            "checkValues": self.check_values,
            "references": list(self.references) if self.references else None,
            "primaryKey": self.primary_key,
            "onDelete": self.on_delete,
        }


class Table:
    __slots__ = ("name", "columns", "foreign_keys", "primary_key", "fk_delete_rules")

    def __init__(self, name: str) -> None:
        self.name = name
        self.columns: dict[str, Column] = {}
        # (local columns, parent table, parent columns)
        self.foreign_keys: list[tuple[list[str], str, list[str]]] = []
        # The declared `ON DELETE` rule of each entry in `foreign_keys`, same
        # order, `None` where the clause states none.
        self.fk_delete_rules: list[str | None] = []
        self.primary_key: list[str] = []

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "columns": [c.as_dict() for c in self.columns.values()],
            "foreignKeys": [
                {"columns": a, "parentTable": b, "parentColumns": c}
                for a, b, c in self.foreign_keys
            ],
            "primaryKey": self.primary_key,
        }


def parse_tables(ddl_text: str) -> dict[str, Table]:
    """Every `CREATE TABLE` in the fixture, keyed by physical table name."""
    tables: dict[str, Table] = {}
    # Strip line comments up front: the fixture's prose is dense with
    # parentheses and the scan below counts them.
    ddl_text = _strip_comments(ddl_text)
    for match in re.finditer(
        r"CREATE TABLE\s+(?:IF NOT EXISTS\s+)?[\"']?(\w+)[\"']?\s*\(",
        ddl_text,
        re.I,
    ):
        # Balance the parentheses rather than looking for a closing delimiter:
        # one table whose body ends unusually must not swallow the next.
        start = match.end()
        depth, index = 1, start
        while index < len(ddl_text) and depth:
            if ddl_text[index] == "(":
                depth += 1
            elif ddl_text[index] == ")":
                depth -= 1
            index += 1
        name, body = match.group(1), _strip_comments(ddl_text[start : index - 1])
        table = Table(name)
        for piece in _split_top_level(body):
            upper = piece.upper()
            fk = _FK_CLAUSE.search(piece)
            if upper.startswith("FOREIGN KEY") and fk:
                table.foreign_keys.append(
                    (
                        [c.strip() for c in fk.group(1).split(",")],
                        fk.group(2),
                        [c.strip() for c in fk.group(3).split(",")],
                    )
                )
                rule = _ON_DELETE.search(piece)
                table.fk_delete_rules.append(
                    re.sub(r"\s+", " ", rule.group(1).upper()) if rule else None
                )
                continue
            if upper.startswith(("CHECK", "UNIQUE", "CONSTRAINT")):
                continue
            if upper.startswith("PRIMARY KEY"):
                pk = _PK_CLAUSE.search(piece)
                if pk:
                    table.primary_key = [c.strip() for c in pk.group(1).split(",")]
                continue
            words = piece.split()
            if not words:
                continue
            col_name = words[0].strip('"')
            declared = words[1].upper().rstrip(",") if len(words) > 1 else ""
            if declared not in _TYPES:
                continue
            column = Column(col_name, declared)
            column.not_null = "NOT NULL" in upper
            if re.search(r"\bPRIMARY\s+KEY\b", upper):
                column.primary_key = True
                table.primary_key = table.primary_key or [col_name]
            check = _CHECK_IN.search(piece)
            if check and check.group(1) == col_name:
                column.check_values = [
                    v.replace("''", "'") for v in _LITERALS.findall(check.group(2))
                ]
            ref = _REFERENCES.search(piece)
            if ref:
                column.references = (ref.group(1), ref.group(2))
            else:
                bare = re.search(r"REFERENCES\s+(\w+)\b(?!\s*\()", piece, re.I)
                if bare:
                    column.references = (bare.group(1), "")
            if column.references:
                rule = _ON_DELETE.search(piece)
                column.on_delete = (
                    re.sub(r"\s+", " ", rule.group(1).upper()) if rule else None
                )
            table.columns[col_name] = column
        # Column-level REFERENCES without a named parent column resolve to the
        # parent's own primary key; a second pass fills them in once every
        # table is known.
        tables[name] = table
    for table in tables.values():
        for column in table.columns.values():
            if column.references and not column.references[1]:
                parent = tables.get(column.references[0])
                target = parent.primary_key[0] if parent and parent.primary_key else ""
                column.references = (column.references[0], target)
        for index, (columns, parent_name, parent_columns) in enumerate(table.foreign_keys):
            if len(columns) == 1 and len(parent_columns) == 1:
                col = table.columns.get(columns[0])
                if col is not None and col.references is None:
                    col.references = (parent_name, parent_columns[0])
                    if index < len(table.fk_delete_rules):
                        col.on_delete = table.fk_delete_rules[index]
    return tables
