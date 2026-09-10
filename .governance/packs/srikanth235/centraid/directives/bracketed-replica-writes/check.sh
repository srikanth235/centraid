#!/usr/bin/env bash
# Directive: bracketed-replica-writes - every write to a replicated table,
# outside the gateway's invocation pipeline, runs inside the replica commit
# pair (#1014, findings N1/G4/G5/G22/G24).
#
# WHY A FILE-LEVEL CHECK AND NOT AN ARRIVAL RULE. `.governance/law` rules read
# `out/arrival.json`, which carries a path, a status and an estate per file and
# no file CONTENT at all - so a rule there cannot see a SQL string. Reading
# tracked source is what a directive does, and `gateway-engine-mode-agnostic`
# is the same shape.
#
# SCOPE, and why it is what it is. A raw statement is judged only where a write
# does NOT pass the invocation pipeline:
#
#   packages/server/src/**          the host layer. It holds the gateway's own
#     (minus engine/**)             vault handle and writes it directly; N1
#                                   (`serve/notices.ts`) lived exactly here.
#   packages/vault/src/gateway/     the two duty entry points outside the
#     gateway.ts, duties.ts         pipeline; G5 (the standing sweep) was here.
#
# Everything else is deliberately out of scope, and each exclusion is a fact
# about the code rather than a convenience:
#
#   packages/vault/src/commands/**  handlers run inside `runContractAndExecute`,
#   and the leaf writers it calls   which brackets the whole invocation.
#   packages/vault/src/schema/**    migration runs before a seat exists.
#   packages/server/src/engine/**   engine may not import `@centraid/vault`
#                                   (oxlint `no-restricted-imports`), so its
#                                   connection is bracketed at the seam instead,
#                                   by `makeReplicatedLedgerDbProvider`
#                                   (`packages/server/src/replicated-ledger-db.ts`).
#
# THE REPLICATED SET IS READ, NOT LISTED. The tables come from the vault
# schema's own `CREATE TABLE` statements minus `PRIVATE_TABLES` minus the log
# plane's own tables - the same three subtractions `replicatedTablesOf` makes -
# so a new table is covered the day it is added and a table moved onto the
# private list stops being covered the same day.
#
# Waiver: `// governance: allow-bracketed-replica-writes <reason>` on the
# offending line, for a write that genuinely must not be captured.
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "bracketed-replica-writes"
require_git

SCHEMA_DIR="packages/vault/src/schema"
if [[ ! -d "$SCHEMA_DIR" ]]; then
    directive_end
fi

# The replicated set, derived from the schema the way the code derives it.
REPLICATED=$(node -e '
const fs = require("node:fs");
const path = require("node:path");
const dir = "packages/vault/src/schema";
const names = new Set();
for (const file of fs.readdirSync(dir)) {
  if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
  const source = fs.readFileSync(path.join(dir, file), "utf8");
  for (const match of source.matchAll(
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z_0-9]*)"?/gi
  ))
    names.add(match[1]);
}
const declared = fs.readFileSync(path.join(dir, "private-tables.ts"), "utf8");
const byKind = declared.slice(
  declared.indexOf("PRIVATE_TABLES_BY_KIND"),
  declared.indexOf("export const PRIVATE_TABLES")
);
for (const match of byKind.matchAll(/^\s{4}([a-z_0-9]+):/gm)) names.delete(match[1]);
for (const shadow of ["replica_log", "replica_meta", "replica_change"])
  names.delete(shadow);
console.log(
  [...names].filter((name) => !name.startsWith("fts_") && name !== "IF").sort().join(" ")
);
' 2>/dev/null) || REPLICATED=""

if [[ -z "$REPLICATED" ]]; then
    violation "the replicated table set could not be derived from $SCHEMA_DIR — the check cannot judge anything, which is a failure, not a pass"
    directive_end
fi

# The bracket, by any of its names. A file that carries none of them has no
# pair anywhere in it, which is exactly the shape every #1014 loss had.
BRACKET='withReplicaCommit|beginReplicaCommit|bracketReplicaWrites'
WRITE='(INSERT[[:space:]]+(OR[[:space:]]+[A-Za-z]+[[:space:]]+)?INTO|UPDATE|DELETE[[:space:]]+FROM)[[:space:]]+"?[a-z_][a-z_0-9]*"?'

while IFS=: read -r file line_no match; do
    [[ -z "$file" ]] && continue
    has_waiver "$file" "$line_no" "bracketed-replica-writes" && continue
    table=$(printf '%s' "$match" | grep -oiE "$WRITE" | head -1 \
        | grep -oE '[a-z_][a-z_0-9]*$')
    [[ -z "$table" ]] && continue
    case " $REPLICATED " in
        *" $table "*) ;;
        *) continue ;;
    esac
    grep -qE "$BRACKET" "$file" && continue
    violation "$file:$line_no - raw write to the replicated table '$table' with no commit pair in the file (wrap it in withReplicaCommit, or bracket the connection with bracketReplicaWrites)"
done < <(git grep -nE "$WRITE" -- \
    'packages/server/src/**/*.ts' ':!packages/server/src/engine/**' \
    'packages/vault/src/gateway/gateway.ts' 'packages/vault/src/gateway/duties.ts' \
    ':!**/*.test.ts' ':!**/*test-fixtures*' ':!**/dist/**' 2>/dev/null || true)

directive_end
