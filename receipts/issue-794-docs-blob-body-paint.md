# Receipt — issue #794: Docs paints blob-backed bodies on both shells

## User impact

Members can open uploaded text documents and see the stored body in both the
desktop and web shells instead of a permanently blank paper surface.

First-run: onboarding and an empty Docs drive are unchanged; the repaired path
appears only after a member uploads and opens a text document. The desktop
journey emits `artifacts/e2e/ui-impact/issue-794-docs-body-paint.png` after the
two persisted body paragraphs are visible.

## Checklist

- [x] Bundled inline Docs reads blob text through the established authenticated
      gateway blob transport without weakening desktop or web CSP.
- [x] Served Docs retains its same-origin content-URI fetch path.
- [x] Reading and Editor share the same host-aware text loader.
- [x] Gateway CORS preflight admits `x-content-sha256`, with an exact-token
      regression assertion.
- [x] Desktop and web Docs journeys assert the member-visible body; the web
      integrity-header stripping shim is removed.
- [x] Current-state Docs scenario documentation describes the repaired path.
- [ ] Fresh-context audit (owned by the root auditor).

## What changed

`packages/client/src/react/blueprints/blob-auth.ts` now shares one authenticated
response primitive between object-URL authorization and `authorizeBlobText`.
`packages/client/src/react/blueprints/centraid-inline.ts` exposes the latter as
`blobText`, with its contract pinned by
`packages/client/src/react/blueprints/centraid-inline.test.ts`.

`packages/blueprints/apps/docs/blob-text.ts` selects that inline door only for
vault blob paths; served apps and other URIs retain ordinary same-origin
`fetch`. `packages/blueprints/apps/docs/components/Reading.tsx` and
`packages/blueprints/apps/docs/components/Editor.tsx` share the helper, while
`packages/blueprints/src/docs-drive.test.ts` proves both host paths.
`packages/blueprints/types/centraid.d.ts` and
`packages/blueprints/manifest.json` publish the new inline capability.

`packages/app-engine/src/http/http-server.ts` admits `x-content-sha256`; the
exact preflight token is pinned in
`packages/app-engine/src/http/http-server.test.ts`. The shim is removed from
`apps/web/tests/e2e/docs-drive.spec.ts`, and that journey plus
`apps/desktop/tests/e2e/docs-drive.spec.ts` asserts both body paragraphs.
`docs/apps/docs-scenarios.md` records the repaired current-state path.

The desktop owner journey now follows the current shell contracts as well:
`apps/desktop/tests/e2e/docs-drive.spec.ts` waits for the direct Home hand-off,
while `apps/desktop/tests/e2e/household.spec.ts` uses the shipped `Copies` frame
title and `apps/desktop/tests/e2e/locker.spec.ts` no longer resurrects the
removed first-run profile gate. These are test-harness alignments only; product
behavior is unchanged.

Checklist crosswalk: **Bundled inline Docs reads blob text through the
established authenticated gateway blob transport without weakening desktop or
web CSP.** **Served Docs retains its same-origin content-URI fetch path.**
**Reading and Editor share the same host-aware text loader.** **Gateway CORS
preflight admits `x-content-sha256`, with an exact-token regression assertion.**
**Desktop and web Docs journeys assert the member-visible body; the web
integrity-header stripping shim is removed.** **Current-state Docs scenario
documentation describes the repaired path.** The changed implementations and
focused host, CORS, and shell journeys above provide each attestation.

## Out of scope

Blob storage format, content hashing, and CSP policy are unchanged. This work
repairs the authorized text transport and its existing CORS contract.

## Decisions

The inline shell reads text from the already authenticated response rather
than creating an object URL, while served Docs keeps the existing same-origin
fetch path. This preserves both host models without broadening CSP.

## Verification

```text
bun run --cwd packages/blueprints test --run src/docs-drive.test.ts
# 1 file / 18 tests passed

bun run --cwd packages/client test --run src/react/blueprints/centraid-inline.test.ts
# 1 file / 15 tests passed

bun run --cwd packages/app-engine test --run src/http/http-server.test.ts
# 1 file / 12 tests passed

bun run --cwd packages/client typecheck
bun run --cwd packages/blueprints typecheck
bun run --cwd packages/app-engine typecheck
bun run --cwd apps/mobile typecheck
bun run --cwd apps/desktop typecheck
bun run --cwd apps/web typecheck
# clean

bun run --cwd apps/desktop test:e2e -- tests/e2e/docs-drive.spec.ts tests/e2e/household.spec.ts tests/e2e/locker.spec.ts
# 4 desktop journeys passed
```

The first combined typecheck pass found the new Docs unit using the browser
`window` identifier outside the test tsconfig's ambient types. The test was
corrected to address the jsdom host through a narrow `globalThis` seam; the
final blueprints typecheck passed.

Demonstrated red on both repaired boundaries:

- bypassing `window.centraid.blobText` made the Docs contract reject with
  `ERR_INVALID_URL` on `/centraid/_vault/blobs/body-sha` (**1 red / 16 green**),
  the inline-shell relative-fetch defect the helper removes;
- removing `x-content-sha256` from the gateway allow-header list made the exact
  preflight assertion fail (**1 red / 11 green**).

Both fixes were restored before the green verification.

## Audit

PASS — fresh-context audit by `/root/receipt_audit_792_796`: the corrected
receipt mirrors issue #794, names every issue-owned file, and the authenticated
inline path, served same-origin fallback, exact CORS token, and shell body-paint
assertions match the diff. The desktop UI artifact is captured only after both
persisted paragraphs are visible; the tightened mock-call assertions preserve
the same contracts (18/18 focused Docs tests passed). The later desktop
journey edits are test-only contract alignment and were verified by the 4/4
focused desktop run above.

## Session

- harness: codex
- date: 2026-08-15

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-15 | codex | 01a003d7-1e6b-7d00-86a3-4831e330af63 |
