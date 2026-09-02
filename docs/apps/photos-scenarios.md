# Photos scenario × layer contract

Instance of [docs/app-scenario-layer-template.md](../app-scenario-layer-template.md). Promoted from the [TESTING.md Photos table](../../TESTING.md#photos-scenario--layer-contract-716) so the nightly scenario ledger has one file per app (#864 Wave 7).

- **App**: Photos · **north star**: Google Photos ([docs/blueprint-seats.md](../blueprint-seats.md#north-stars)).
- **Seat class**: `byte-bearing` — real member files; custody triple, backup, pin/download, free-up-space.
- **Graduation issue**: [#716](https://github.com/srikanth235/centraid/issues/716); remaining write-path holes tracked under [#864](https://github.com/srikanth235/centraid/issues/864).
- **Journey ownership**: one north-star journey per platform. Origin: `tests/agent-e2e-mobile/flows/photos-library.mjs` (and the four sibling Photos Maestro flows). Custodian: `apps/desktop/tests/e2e/photos.spec.ts`. Viewer: `apps/web/tests/e2e/photos-grants.spec.ts`.
- **Structural exclusions**: see `tests/claims.json#appEngines`.

`U` is a pure/unit test, `C` a component test (RNTL on native, jsdom on web), `E` a named journey. A row owns one cheapest falsifying layer.

| Photos scenario | U | C | E | Owner / evidence |
| --- | --- | --- | --- | --- |
| drawer activity, hide timer, pinned summary grains | — | ✅ | — | `apps/mobile/src/apps/photos/PhotosHome.test.tsx` |
| library origin journey | — | — | ✅ | `tests/agent-e2e-mobile/flows/photos-library.mjs` |
| search grouping and no-hits | ✅ | — | — | `packages/blueprints/apps/photos/search-groups.test.ts` |
| search device journey | — | — | ✅ | `tests/agent-e2e-mobile/flows/photos-search.mjs` |
| viewer chrome and filmstrip | ✅ | — | — | `packages/blueprints/apps/photos/viewer.test.ts` |
| Collections shelves and grouping | ✅ | — | — | `packages/blueprints/apps/photos/grouping.test.ts` |
| permission-refused takeover | — | — | ✅ | `tests/agent-e2e-mobile/flows/photos-permissions.mjs` |
| selection trash + restore write | — | — | ✅ | `tests/agent-e2e-mobile/flows/photos-select-write.mjs` |
| designed pending/parked/conflict | — | ✅ | — | `packages/blueprints/apps/photos/states.test.tsx` |
| storage custody arithmetic | ✅ | — | — | `packages/blueprints/apps/photos/storage-model.test.ts` |
| web/desktop import (`runUpload`) does not drop files | ✅ | — | — | `packages/blueprints/apps/photos/upload.test.ts` — drop completeness over `dataTransfer.items`, 96-file claim order |
| free-up-space preserves pinned originals | ✅ | — | — | `apps/mobile/src/apps/photos/photos-library-pins.test.ts` — pin join against folded asset ids |
| hide vs archive mean the same thing on every seat | ✅ | — | — | `packages/blueprints/apps/photos/archive-copy.test.ts`; mobile overflow in `apps/mobile/src/apps/photos/viewer-menu.test.ts` |
