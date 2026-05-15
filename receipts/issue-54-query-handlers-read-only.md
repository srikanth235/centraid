# issue-54 — Enforce read-only query handlers via governance directive

GitHub issue: [#54](https://github.com/srikanth235/centraid/issues/54)

## Checklist

- [x] New local pack
- [x] `query-handlers-read-only` directive triple
- [x] CONSTITUTION.md
- [x] `.governance/packs.lock` sync
- [x] Positive smoke
- [x] Waiver smoke
- [x] Negative smoke
- [x] runtime.ts file-size waiver

## What changed

**New local pack.** `.governance/packs/srikanth235/centraid/pack.yaml` declares this repo's first hand-authored pack (`source: local`, version `0.1`). The pack will house directives that depend on centraid-specific runtime conventions — things `governance-kit/core` can't know about. Its lockfile entry in `.governance/packs.lock` sits alongside `governance-kit/core` and lists `query-handlers-read-only` as its sole directive.

**`query-handlers-read-only` directive triple.** The atomic-triple lives at `.governance/packs/srikanth235/centraid/directives/query-handlers-read-only/`:

- `directive.yaml` — `category: Correctness`, `surface: repo-state`, `hook: pre-commit`. The summary names the failure mode in one paragraph so a future reader doesn't have to spelunk for the rationale.
- `check.sh` — sources `../../../../../lib.sh` (the five-up path that `lib.sh`'s header documents), runs `git grep -nE '(\.run\(|db\.exec\()' -- '**/queries/*.js'`, honors per-line waivers via `has_waiver`. The pattern uses `db.exec(` with the `db.` qualifier rather than a `\b` word boundary because `git grep -E` is POSIX ERE — no `\b` support (we discovered this in the smoke loop). Distinguishes `.run(` vs `db.exec(` in the violation message so a reader knows whether the offender is a prepared-statement write or a raw exec.
- `constitution.md` — self-describing copy of the Directives subsection so the directive folder stays installable.

**CONSTITUTION.md.** New Directives subsection after `receipt-per-issue` (the constitution lists directives in pack order, not alphabetical) plus a new Evolution Log entry dated `2026-05-15`.

**`.governance/packs.lock` sync.** Appended a `source: local` entry for `srikanth235/centraid` at version `0.1` listing `query-handlers-read-only` — keeps `governance pack list`, `governance reset`, and `governance uninstall` consistent with on-disk state.

**runtime.ts file-size waiver.** `packages/runtime-core/src/runtime.ts` crossed 500 lines (now 505) after the SSE wiring earlier in this session pushed `runtime.changeBus`, `emitForApp`, and the `app-changes` case into it. Added a head-of-file `governance: allow-repo-hygiene file-size-limit pending split into changes-feed / app-routes modules` waiver — same pattern apps/desktop/src/main/chat.ts already uses. The split (carving the SSE plumbing into `changes-feed.ts` and the route switch into `app-routes.ts`) lands in the follow-up that ships the SSE feed end-to-end.

## Out of scope

- **Splitting runtime.ts** into `changes-feed.ts` / `app-routes.ts`. The waiver documents the debt; the split is its own commit in the SSE PR.
- **Per-line waivers in existing query handlers.** None of the template `queries/*.js` files trigger the directive today — they all use `.all()` / `.get()`. If a future handler legitimately needs an opt-in write (lazy view materialization is the canonical case in the directive doc), the author adds the waiver at that line.
- **Wider write-coverage discipline.** The directive only enforces "no writes in query handlers." Writes from actions and crons are correct usage and pass session tracking; no policy needed there.
- **OpenClaw-side enforcement.** The directive checks repo state in this monorepo. Apps published to a remote OpenClaw gateway are not scanned post-deploy — that would need a separate runtime guard.

## Verification

- `bash .governance/packs/srikanth235/centraid/directives/query-handlers-read-only/check.sh` — passes (exit 0) on the current tree.
- `bash .governance/run.sh query-handlers-read-only` — auto-discovers and runs the new directive without any hook reinstall.
- Positive smoke: plant `await db.prepare('UPDATE …').run()` and `await db.exec('DELETE …')` into `packages/app-templates/todos/queries/list.js` → directive fires with two violations, one labelled `stmt.run()` and one labelled `db.exec()`.
- Waiver smoke: inline `// governance: allow-query-handlers-read-only <reason>` on the offending line → directive passes clean.
- Negative smoke: revert the plant → directive passes again.
- Lockfile sync: `.governance/packs.lock` shows the new `srikanth235/centraid` entry with `query-handlers-read-only` as its directive list.
- `bash .governance/run.sh repo-hygiene` — passes with the new waiver line on runtime.ts.
