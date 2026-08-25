# Notes scenario × layer contract

Instance of [docs/app-scenario-layer-template.md](../app-scenario-layer-template.md).

- **App**: Notes · **north star**: Apple Notes ([docs/blueprint-seats.md](../blueprint-seats.md#north-stars)).
- **Seat class**: `byte-bearing` via attachments; notes themselves are records with optional blobs.
- **Graduation issue**: none yet — rides the blended floor; write-path holes tracked under [#864](https://github.com/srikanth235/centraid/issues/864).
- **Journey ownership**: origin `tests/agent-e2e-mobile/flows/notes-library.mjs`; custodian `apps/desktop/tests/e2e/notes.spec.ts`; viewer `apps/web/tests/e2e/notes.spec.ts`.
- **Structural exclusions**: see `tests/matrix.json#appEngines`.

| Notes scenario | U | C | E | Owner / evidence |
| --- | --- | --- | --- | --- |
| library origin journey | — | — | ✅ | `tests/agent-e2e-mobile/flows/notes-library.mjs` |
| designed pending/parked/offline/conflict | — | ✅ | — | `packages/blueprints/apps/notes/states.test.tsx` |
| shelf routing | ✅ | — | — | `packages/blueprints/apps/notes/shelves.test.ts` |
| format / commonmark | ✅ | — | — | `packages/blueprints/apps/notes/format.test.ts` |
| command dispatch | ✅ | — | — | `packages/blueprints/apps/notes/logic-commands.test.ts` |
| Pin/Add-tag/Attach in the editor keeps the body | — | ✅ | — | `packages/blueprints/apps/notes/editor-keep-body.test.tsx` |
| autosave debounce does not drop a write on note-switch | ✅ | — | — | `packages/blueprints/apps/notes/logic-commands.test.ts` |
| "Both are kept" conflict panel is a live control | ✅ | — | — | `packages/blueprints/apps/notes/logic.test.ts` |
| a new web note is named from its title, not Untitled note | — | — | — | **product-bug** (#864, S2): every web note is named "Untitled note" |
