### query-handlers-read-only

- **Directive**: centraid query handlers (`*/queries/*.js`) must not mutate the database — no `stmt.run()`, no `db.exec()`. Use `actions/*.js` (POST `/_run`) for any writes.
- **Rationale**: the runtime's handler-runner skips SQLite session tracking for `handlerKind === 'query'` as a perf optimization on the read path (`packages/runtime-core/src/handler-runner.ts`). Writes from a query handler succeed but are invisible to the change-notification SSE feed at `/centraid/<id>/_changes`, so subscribed iframes never re-fetch — UI goes silently stale with no error anywhere. Mutations must live where the bus actually observes them.
- **Enforced by**: `.governance/packs/srikanth235/centraid/directives/query-handlers-read-only/check.sh`
- **Exceptions**: per-line waiver `// governance: allow-query-handlers-read-only <reason>` for the rare opt-in case (e.g. lazy view materialization on first access).
