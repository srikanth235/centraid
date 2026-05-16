#!/usr/bin/env bash
# Directive: query-handlers-read-only — centraid query handlers must not
# mutate the database. The handler runner skips session tracking for
# handlerKind === 'query' (see packages/runtime-core/src/handler-runner.ts),
# so writes from a query handler succeed but are invisible to the change-
# notification SSE feed at /centraid/<id>/_changes. App UIs go stale with
# no error anywhere. Mutations belong in actions/*.js (POST /_run).
#
# Detection: any call to `stmt.run(` or `db.exec(` inside a tracked
# `queries/*.js` file. In ScopedDb's API (packages/runtime-core/src/types.ts)
# `.run()` is the write API — `.get()`/`.all()` are reads — and `db.exec()`
# accepts arbitrary SQL including DML/DDL. Both patterns indicate the
# handler is reaching past the read-only contract.
#
# Waiver: rare cases where a query needs an opt-in write (e.g. lazy view
# materialization on first access) can carry
#   `// governance: allow-query-handlers-read-only <reason>`
# on the offending line.
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "query-handlers-read-only"
require_git

# Match `.run(` and `db.exec(` inside any queries/*.js. The pathspec
# `**/queries/*.js` covers both packages/app-templates/<name>/queries/ in
# this repo today and any future tree where a centraid app's handlers live.
# `git grep -E` is POSIX ERE — no `\b` word boundary support — so we anchor
# `db.exec(` with the leading `db.` qualifier instead. False-positive risk
# (a custom helper named `db.exec`) is acceptable; renaming around the
# rule defeats the rule.
PATTERN='(\.run\(|db\.exec\()'

while IFS=: read -r file line_no match; do
    [[ -z "$file" ]] && continue
    has_waiver "$file" "$line_no" "query-handlers-read-only" && continue
    # Distinguish the two patterns in the message so a reader knows whether
    # it's a prepared-statement write or a raw exec.
    if [[ "$match" == *"db.exec("* ]]; then
        violation "$file:$line_no — query handler calls db.exec() (writes are invisible to /_changes; move to actions/)"
    else
        violation "$file:$line_no — query handler calls stmt.run() (writes are invisible to /_changes; move to actions/)"
    fi
done < <(git grep -nE "$PATTERN" -- '**/queries/*.js' 2>/dev/null || true)

directive_end
