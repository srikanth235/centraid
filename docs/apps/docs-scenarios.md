# Docs scenario × layer contract

Instance of [docs/app-scenario-layer-template.md](../app-scenario-layer-template.md).

- **App**: Docs · **north star**: Google Drive ([docs/blueprint-seats.md](../blueprint-seats.md#north-stars)).
- **Seat class**: `byte-bearing` — real member files; custody triple, staged blob upload, download-on-demand.
- **Graduation issue**: none yet — Docs rides the blended `_shared` + non-graduated coverage floor; [#781](https://github.com/srikanth235/centraid/issues/781) tracks the admission-contract gaps this table closes and names.
- **Journey ownership**: byte-bearing, so one north-star journey per platform. Desktop: `apps/desktop/tests/e2e/docs-drive.spec.ts`. Web: `apps/web/tests/e2e/docs-drive.spec.ts`. Mobile: the native Docs surface has **no journey yet** — a gap under #781, not a skip.
- **Structural exclusions** (`tests/matrix.json#appEngines`, citing [engine contracts](../blueprint-seats.md#engine-contracts)): triage (no shipped correction-proposal queue) and search scaffold (Docs does not consume it; its FTS search is its own query). All other engine cells pass through the canonical conformance gates.

`U` is a pure/unit test, `C` a component test, `E` a named Playwright journey. A row owns one cheapest falsifying layer; `U + E` is intentional only where the claims differ.

| Docs scenario | U | C | E | Owner / evidence |
| --- | --- | --- | --- | --- |
| upload a file; the document and its bytes survive a reload | — | — | ✅ | `docs-drive.spec.ts` (desktop + web): real staged-blob upload through the visible control, reload, reopen, byte-exact round-trip through the authed transport, and the reading route opens |
| drive window: folders, newest-filed-first, bounded window | ✅ | — | — | `packages/blueprints/src/docs-drive.test.ts` (filter axes, breadcrumb, window truncation) |
| shelf strip routing and band tabs | ✅ | — | — | `packages/blueprints/src/docs-shelves.test.ts` |
| custody mark: annotate the exception, never the norm | ✅ | — | — | `packages/blueprints/apps/docs/custody-row-mark.test.ts` |
| file-kind colours meet the contrast rulebook | ✅ | — | — | `packages/blueprints/apps/docs/kind-colours.test.ts` |
| download on demand: explicit act, honest progress, no fabricated totals | ✅ | — | — | `packages/blueprints/src/download-on-demand.test.ts` |
| device-side PDF text extraction with gateway degradation | ✅ | — | — | `packages/blueprints/src/docs-media.test.ts` |
| edit in place / version restore lands the exact restored bytes | ✅ | — | — | vault `core.edit_document` / `restore_document_version` command contracts (`packages/vault`); the journey exercises upload only — versions in a journey are a #781 follow-up |
| pending writes: replica ⊕ outbox overlay on Docs actions | ✅ | — | — | `packages/blueprints/apps/docs/pending-projection.ts` via the shared `_shared/pending-overlay.test.ts` law; the shared record-only replica journey owns the cross-app E proof |

Vault-facing actions (`actions/*.ts`) all funnel through typed `ctx.vault.invoke` commands and return the gateway's own refusal reason on failure; the handler contracts live with the vault command suites (`packages/vault/src/gateway/gateway.contract.test.ts`) and the engine-conformance lint.

Known gaps (tracked, not disguised): no mobile journey; no journey-level version-history proof; no Docs-specific journey budget file yet (the desktop/web suites' shared wall-clock ratchet is the only backpressure); and the reading view's blob-backed BODY paint is broken on both shells — `Reading.tsx` fetches the row's `/centraid/_vault/blobs/…` path relative to the shell document (file:// on desktop, the PWA origin on web), and neither shell CSP allows the `blob:` object-URL alternative in `connect-src`, so a blob-backed text document lands in the honest "could not be fetched" state (#781). The journeys therefore assert the byte round-trip through the authed transport and the reading route, not the body paint.
