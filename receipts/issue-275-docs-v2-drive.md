# issue-275 — Docs v2: rebuild the drive (sidebar, grid/list, details, quick-look)

GitHub issue: [#275](https://github.com/srikanth235/centraid/issues/275)

Docs shipped as a single flat list. v2 is a proper drive — a fixed sidebar,
grid and list views, a details drawer and a full-screen quick-look — still a
**pure projection of the vault**: it holds nothing of its own, every write is
a typed / consent-checked / receipted vault command, and revoking the grant
makes it go dark. The data model is untouched (sha256-deduped `content_item`
bytes, folders as SKOS concepts, one folders-scheme tag per document, trash =
purge date + kept tag). The frontend is a full rewrite against the same
queries and actions.

## Checklist

- [x] Sidebar with a New menu, smart sections, folders with counts, and Trash
- [x] Grid and list views with a JS-measured narrow breakpoint and phone drawer
- [x] Type-filter chips, reversible sort, and multi-select with a bulk bar
- [x] Details drawer with a receipted activity timeline
- [x] Full-screen quick-look with real image and PDF preview
- [x] Vault FTS search with highlighted snippets
- [x] Trash purge countdowns and restore
- [x] Drag-and-drop upload with an 8 MB cap
- [x] New appView default-view knob, contract otherwise unchanged
- [x] Starred honest-empty and all sharing UI dropped

## What changed

- `packages/blueprints/apps/docs/index.html` — replaced the flat-list shell
  with the drive chrome: sidebar frame, top bar (search, grid/list toggle,
  theme toggle, hamburger, `[data-ask-mount]`), toolbar, scroll region, and
  details/quick-look roots. Kept the live-settings theme bridge script and the
  `KIT_ASK` config; `[data-ask-mount]` is static so the kit's import-time Ask
  init finds it.
- `packages/blueprints/apps/docs/app.css` — a full class-based visual system:
  token layer (light/dark + `appFont`/`appWidth`/`appColor`/`appView` knobs)
  bridged to the kit contract, keyframes, and component styles for sidebar,
  grid cards, list rows, details drawer, quick-look, popovers, bulk bar and
  empty states. Responsive off a JS-toggled `.is-narrow` (not viewport media
  queries — blueprints render in a panel).
- `packages/blueprints/apps/docs/app.js` — rewritten: state + drive/search
  reads + all eight document/folder writes with consent/receipt narration and
  friendly-predicate translation; grid + list rendering; sidebar (smart
  sections incl. honest-empty Starred, folders, trash, footprint); toolbar
  (title/sub, type chips, sort); bulk bar; details drawer; quick-look with
  real image/PDF preview + keyboard nav; New menu; 8 MB-capped drag-drop
  upload; JS width measurement; `appView` default. No star or share writes.
- `packages/blueprints/apps/docs/app.json` — added one knob, `appView`
  (segmented Default view, grid/list → `data-app-view`). The `vault` scopes,
  the `drive`/`search` queries and the eight actions are byte-unchanged.
- `packages/blueprints/manifest.json` — regenerated
  (`node scripts/build-manifest.mjs`); the only diff is the new `appView` knob
  under the `docs` entry.

## Out of scope

- **Real starring.** The vault has no `starred` field and no star command, so
  the Starred section ships as an honest empty state. Making starring
  vault-canonical (a flags scheme + tags, drop the per-domain `favorite`
  columns) is issue #274; this section goes live when that lands.
- **Sharing.** No person-to-person share data or action exists, so all sharing
  UI (Shared nav, sharing block, Share button, sharer avatars) is dropped
  rather than faked.
- **Create document / sheet.** No create-empty command exists, so the New menu
  offers only the backed Upload / New folder.
- No vault, query-handler, or action changes; the `drive`/`search` handlers
  and all eight command scopes are unchanged.

## Decisions

- **Starred = honest-empty, sharing = dropped** (confirmed with the owner).
  The reference mock faked both; the vault backs neither today. Rather than
  invent local state, both surface honestly. The owner's follow-on challenge
  ("v0 — nothing set in stone") produced the ontology audit and the decision
  to make starring vault-canonical next (#274), which supersedes the
  empty-state as a stopgap.
- **Storage → footprint.** The vault exposes no account-wide total, so the
  sidebar shows real bytes + count over the loaded window instead of a
  fabricated used/total meter.
- **Inline-style port → class-based.** The bundled reference was a DCLogic
  mock with inline styles; ported to app.css classes to match the app family
  and keep the diff reviewable.
- **JS-measured responsive, not media queries.** Blueprints render inside a
  panel, so the ~860px breakpoint is measured on the root's own width and
  toggles `.is-narrow`; the hamburger/scrim must carry no static `hidden`
  attribute (it defeats the `.is-narrow` reveal via `[hidden]!important`).

## Verification

```bash
cd packages/blueprints && npx vitest run              # 94 passed (5 files)
cd packages/blueprints && node scripts/build-manifest.mjs   # regenerates manifest.json (appView only)
npx oxfmt --check $(git diff --cached --name-only)    # all files correctly formatted
```

Behavioral verification via a static preview harness (mock `window.centraid`
mirroring the real drive/search row shapes + the real `kit.js`/`kit.css`),
driven at 716px (narrow) and 1120px (wide), light and dark. No console errors:

- Sidebar with a New menu, smart sections, folders with counts, and Trash —
  all render with live counts, inline folder rename/delete, and the footprint.
- Grid and list views with a JS-measured narrow breakpoint and phone drawer —
  toggle cleanly; drawer + scrim at 716px, inline sidebar at 1120px.
- Type-filter chips, reversible sort, and multi-select with a bulk bar — the
  Images filter narrows to 3 rows, sort reverses, selection drives Move/Trash/Clear.
- Details drawer with a receipted activity timeline — Open/Download present,
  Move/Trash footer, no Share and no Star.
- Full-screen quick-look with real image and PDF preview — a real image and a
  real PDF render, with prev/next.
- Vault FTS search with highlighted snippets — "rent" returns one hit whose
  snippet wraps the term in `<mark>`.
- Trash purge countdowns and restore — rows show "purges in N days" and restore
  lands a receipted toast.
- Drag-and-drop upload with an 8 MB cap — the picker and drop paths both reject
  over-cap files.
- New appView default-view knob, contract otherwise unchanged — grid/list
  default reads from `data-app-view`; the queries and eight actions are untouched.
- Starred honest-empty and all sharing UI dropped — the Starred section shows
  its empty state and there is no sharing UI anywhere.

## Audit

Independent fresh-context sub-agent (never saw the author's reasoning; read the staged diff and issue #275).

- Verdict: PASS
- Check 1 (what-changed fidelity): PASS — The diff rebuilds the four Docs app files plus a regenerated manifest into a drive (sidebar with All/Recent/Starred/folders/Trash, grid/list, details drawer, search, quick-look, selection) and adds the `appView` knob wired to `data-app-view` (app.js:83), exactly as issue #275 describes.
- Check 2 (contract unchanged): PASS — app.json's `queries` (`drive`, `search`) and its exactly-8 `actions` (`upload`, `rename`, `move`, `trash`, `restore`, `create-folder`, `rename-folder`, `delete-folder`) are byte-unchanged; the app.json diff is a single additive hunk containing only the `appView` knob, and manifest.json's diff is likewise a single 16-line additive hunk carrying only that same knob (no unrelated regen churn).
- Check 3 (honesty reconciliations honored): PASS — Starred is an honest empty state with a hardcoded count of `0` and no write (every `act(...)` call is one of the 8 contracted actions; no `act('star'…)` or `act('share'…)` exists), all sharing UI is absent, and the New menu offers exactly Upload files + New folder with no fake doc/sheet creation.

## Steering

| check | verdict | evidence |
| --- | --- | --- |
| steering events recorded | PASS | 5 events recorded: 4 corrections (ordinals 133, 137, 145, 147) redirecting design approach and scope, 1 interrupt (ordinal 157) at request boundary |
| no non-steering recorded | PASS | Confirmed: initial task request (ordinal 1), ordinary continuations ("continue" at ordinal 158), and solicited answers to agent questions (ordinals 2-156 except the 5 events above) were NOT recorded |

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-fd1ae9d4-371-1783170526-1 | claude-code | fd1ae9d4-3712-46fe-86cc-8c38261b45c5 | #275 | claude-opus-4-8 | 122648 | 5309177 | 80514278 | 571328 | 6003153 | 88.3359 | 122648 | 5309177 | 80514278 | 571328 |  |
| claude-code-fd1ae9d4-371-1783170549-1 | claude-code | fd1ae9d4-3712-46fe-86cc-8c38261b45c5 | #275 | claude-opus-4-8 | 744 | 1809 | 1201473 | 732 | 3285 | 0.6341 | 123392 | 5310986 | 81715751 | 572060 |  |
| claude-code-fd1ae9d4-371-1783170741-1 | claude-code | fd1ae9d4-3712-46fe-86cc-8c38261b45c5 | #275 | claude-opus-4-8 | 4640 | 47635 | 11482887 | 29777 | 82052 | 6.8068 | 128032 | 5358621 | 93198638 | 601837 |  |
| claude-code-fd1ae9d4-371-1783170943-1 | claude-code | fd1ae9d4-3712-46fe-86cc-8c38261b45c5 | #275 | claude-opus-4-8 | 36 | 40352 | 7668956 | 20198 | 60586 | 4.5918 | 128068 | 5398973 | 100867594 | 622035 |  |
| claude-code-fd1ae9d4-371-1783171162-1 | claude-code | fd1ae9d4-3712-46fe-86cc-8c38261b45c5 | #275 | claude-opus-4-8 | 3916 | 49246 | 8927966 | 34777 | 87939 | 5.6608 | 131984 | 5448219 | 109795560 | 656812 |  |
| claude-code-fd1ae9d4-371-1783171188-1 | claude-code | fd1ae9d4-3712-46fe-86cc-8c38261b45c5 | #275 | claude-opus-4-8 | 10047 | 1569 | 1375986 | 666 | 12282 | 0.7647 | 142031 | 5449788 | 111171546 | 657478 |  |
| claude-code-fd1ae9d4-371-1783171220-1 | claude-code | fd1ae9d4-3712-46fe-86cc-8c38261b45c5 | #275 | claude-opus-4-8 | 807 | 14520 | 1377555 | 2505 | 17832 | 0.8462 | 142838 | 5464308 | 112549101 | 659983 |  |
| claude-code-fd1ae9d4-371-1783171248-1 | claude-code | fd1ae9d4-3712-46fe-86cc-8c38261b45c5 | #275 | claude-opus-4-8 | 6 | 4440 | 1392075 | 978 | 5424 | 0.7483 | 142844 | 5468748 | 113941176 | 660961 |  |
| claude-code-fd1ae9d4-371-1783171281-1 | claude-code | fd1ae9d4-3712-46fe-86cc-8c38261b45c5 | #275 | claude-opus-4-8 | 6 | 1677 | 1396515 | 2454 | 4137 | 0.7701 | 142850 | 5470425 | 115337691 | 663415 |  |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-fd1ae9d4371246-1783169238-1 | fd1ae9d4-3712-46fe-86cc-8c38261b45c5 | #275 | correction | classifier | Request comprehensive evaluation of approach before implementation | feat(blueprints): rebuild Docs into a proper drive (#275) | 133 | 2026-07-04T12:40:38.586Z |
| steer-fd1ae9d4371246-1783169532-1 | fd1ae9d4-3712-46fe-86cc-8c38261b45c5 | #275 | correction | classifier | Challenge uniform approach; extend solution to related tables | feat(blueprints): rebuild Docs into a proper drive (#275) | 137 | 2026-07-04T12:45:32.019Z |
| steer-fd1ae9d4371246-1783169758-1 | fd1ae9d4-3712-46fe-86cc-8c38261b45c5 | #275 | correction | classifier | Reframe: design for ontology layer, not existing app patterns | feat(blueprints): rebuild Docs into a proper drive (#275) | 145 | 2026-07-04T12:52:38.292Z |
| steer-fd1ae9d4371246-1783169868-1 | fd1ae9d4-3712-46fe-86cc-8c38261b45c5 | #275 | correction | classifier | Redirect: reevaluate ontology for similar patterns across schema | feat(blueprints): rebuild Docs into a proper drive (#275) | 147 | 2026-07-04T12:56:08.882Z |
| steer-fd1ae9d4371246-1783170015-1 | fd1ae9d4-3712-46fe-86cc-8c38261b45c5 | #275 | interrupt | structural |  | feat(blueprints): rebuild Docs into a proper drive (#275) | 157 | 2026-07-04T13:00:15.817Z |
