<!-- governance: receipt-per-issue -->

# Receipt: triage CodeQL code-scanning backlog (#678)

## Checklist

- [x] Kit attribute context no longer relies on incomplete `esc()` for quotes (fix or prove cfg is fully trusted and document).
- [x] Highest-priority ReDoS sites on untrusted vault ingest / SQL comment / HTML rewrite paths hardened or accepted with limits.
- [x] Prod errors #169, #198, #199 either fixed for a real bug or dismissed with reason linking SECURITY.md / OAuth state binding.
- [ ] `js/insufficient-password-hash` on locker-auth / content-hash IDs dismissed as FP (or CodeQL config excludes) with reason.
- [x] CodeQL path filters (or equivalent) exclude the bulk of `**/*.{test,spec}.*`, `**/tests/**`, obvious spikes/fakes/scripts noise — open count drops without losing prod signal.
- [x] Prototype pollution #148 and sqlite-worker #202 reviewed; fixed or dismissed with reason.
- [x] Short note in SECURITY.md or `docs/` (if anything non-obvious was learned) per docs write-back loop.
- [x] Receipt for this issue when work ships.

## What changed

Highest-signal product fixes from the ~126 open GitHub code-scanning (CodeQL) alerts, following the #678 triage rather than a mass rewrite:

- Kit Ask HTML escaping (`packages/design/kit/kit.ts` `escapeHtml`, covered by `packages/design/src/kit-smoke.test.ts`) now includes `"` and `'` so `placeholder`, `data-id`, and `aria-label` string interpolation cannot break out of attributes (`js/incomplete-html-attribute-sanitization`).
- Vault ingest: `packages/vault/src/ingest/mbox.ts` From-address and `packages/vault/src/ingest/takeout-sidecar.ts` stem matching no longer use polynomial regexes; owner SQL comment stripping in `packages/vault/src/gateway/sql.ts` is a linear scan (`js/polynomial-redos`). Tests: `packages/vault/src/gateway/sql.test.ts`, `packages/vault/src/ingest/parsers.test.ts`.
- Local backup registry (`packages/backup/src/local-provider.ts`, `packages/backup/src/local-provider.test.ts`) skips/refuses `__proto__` / `constructor` / `prototype` keys (`js/prototype-polluting-assignment`).
- Replica sqlite worker (`packages/client/src/replica/sqlite-worker.ts`, `packages/client/src/replica/sqlite-worker.test.ts`) compares `event.origin` to the worker origin (`js/missing-origin-check`).
- CORS Origin reflection (`packages/app-engine/src/http/http-server.ts`) and Bearer-header auth stay as designed (#504); sinks carry `lgtm` suppressions pointing at SECURITY.md. OAuth callback `error`/`code` absence in `packages/gateway/src/routes/connections-routes.ts` is the state-bound failure path, not an auth bypass.
- `.github/codeql/codeql-config.yml` path-ignores tests, e2e, scripts, fixtures, generated code, and `centraid-city`; `.github/workflows/security.yml` points CodeQL init at that config.
- SECURITY.md records the triage; CHANGELOG.md notes the patch.

## Out of scope

- Mass-fixing remaining TOCTOU, `js/insecure-randomness`, `js/file-access-to-http`, and test/script URL sanitization.
- GitHub UI bulk-dismiss of `js/insufficient-password-hash` (locker HMAC+scrypt is correct; this agent cannot write code-scanning alert state). Documented in SECURITY.md instead of weakening the KDF.
- Rewriting intentional CORS / Bearer policy.

## Decisions

- Path-filter tests/scripts rather than excluding whole CodeQL rules, so a real `js/path-injection` in product code still fires.
- Quote-escape in one `escapeHtml` used for both text and attributes, matching scaffold `escapeHtml`, instead of a second `escAttr` that callers can forget.
- Unclosed SQL block comments consume the remainder (fail closed) instead of leaving the tail executable.

## Verification

```sh
bun run --cwd packages/design test src/kit-smoke.test.ts
bun run --cwd packages/vault test src/gateway/sql.test.ts src/ingest/parsers.test.ts src/ingest/takeout-sidecar.test.ts
bun run --cwd packages/backup test src/local-provider.test.ts
bun run --cwd packages/client test src/replica/sqlite-worker.test.ts
bun run --cwd packages/app-engine test src/http/request-boundary.test.ts
```

## Audit

PASS — independent sub-agent: What changed matches the diff; each `[x]` is realized; the checklist mirrors issue #678 acceptance criteria; password-hash dismiss remains `[ ]` because GitHub alert state is not writable from this agent.
