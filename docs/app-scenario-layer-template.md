# App scenario × layer template

The reusable shape behind the [app admission contract](../TESTING.md#app-admission-contract). When an app graduates beyond sample data, its design record instantiates this template as `docs/apps/<app>-scenarios.md`; the Photos table in [TESTING.md](../TESTING.md#photos-scenario--layer-contract-716) is the reference instance. The template was first extracted by #725 and re-homed here as a state doc after the `docs/plans/` retirement (#767); [#781](https://github.com/srikanth235/centraid/issues/781) restored it.

## Header facts

An instance opens by naming, in prose or a definition list:

- **App** and its **north star** (from [docs/blueprint-seats.md](blueprint-seats.md#north-stars)).
- **Seat class** — `record-only` or `byte-bearing` (the two classes in [docs/blueprint-seats.md](blueprint-seats.md#two-classes-of-blueprint)).
- **Graduation issue** — the issue whose measurement seeded the app's own coverage floor, or the tracking issue while the app still rides the blended floor.
- **Journey ownership** — for a byte-bearing app: one north-star journey **per platform** it ships on, each with a tighten-only budget beside its flows; for a record-only app: the shared record-only replica journey (`pending-overlay.spec.ts` on desktop and web), until the app gains a genuinely app-specific native integration.
- **Structural exclusions** — every engine the app is structurally excluded from, recorded as `skip` cells in `tests/claims.json#appEngines` citing [docs/blueprint-seats.md#engine-contracts](blueprint-seats.md#engine-contracts). Exclusions live in the matrix, not in this table: a scenario that cannot exist is not a row.

## The table

One row per product scenario the app must prove. Columns are the three falsifying layers:

| Column | Layer | What qualifies |
| --- | --- | --- |
| `U` | pure/unit | a `*-model.ts` (or equivalent pure module) beside the view, exercised by `*.test.ts` |
| `C` | component | RNTL/Vitest for native role/state/responder semantics, or jsdom component tests where the claim is DOM semantics |
| `E` | journey | one named platform journey: Playwright `*.spec.ts` (desktop/web) or Maestro flow `*.mjs` (mobile) |

| `<App>` scenario | U | C | E | Owner / evidence |
| --- | --- | --- | --- | --- |
| `<scenario>` | ✅/— | ✅/— | ✅/— | `<owning file(s)>`; one clause on what each checked layer uniquely falsifies |

Row rules, from the admission contract:

- **One cheapest falsifying layer per scenario.** A row normally checks one column. `U + E` (or `U + C`, `C + E`) is intentional only when the layers prove **different claims** — model arithmetic versus device/runtime integration — and the Owner cell must say which claim each carries.
- **Rows are scenarios, not files.** "Create a doc and its bytes survive a reload" is a row; "drive.ts" is not.
- **Vault-facing actions** each have a handler contract (happy-path postcondition, refusal/partial-failure behavior, owning contract file). List them under the table if they are not already a row.
- **A journey column is honest only if the named journey exists and runs in a lane.** A planned journey is a `gap` with a tracking issue, written as `— (#NNN)`, never a ✅.

## Wiring an instance in

- The journey flows join `tests/claims.json#flows` (journey tier) so the computed grade sees them; the app's engine cells in `#appEngines` stay pass/skip as the seat doctrine dictates.
- Journeys reuse the seeded `@centraid/test-kit/year3-vault` profile where the platform run shares one; a destructive/exclusive-state journey runs first and explicitly reseeds.
- PR workflows path-filter the app's journey by the changed app directory; the suite wall-clock ratchet is the global backpressure.
- A graduating app leaves the blended coverage floor for a measured scope of its own (`tests/floors.json#coverage`), tied to the graduation issue.

## Instances

- Photos — [docs/apps/photos-scenarios.md](apps/photos-scenarios.md) (reference instance, native-first; TESTING.md still cites it).
- Docs — [docs/apps/docs-scenarios.md](apps/docs-scenarios.md).
- Notes — [docs/apps/notes-scenarios.md](apps/notes-scenarios.md).
- Tasks — [docs/apps/tasks-scenarios.md](apps/tasks-scenarios.md).
- Agenda — [docs/apps/agenda-scenarios.md](apps/agenda-scenarios.md).
- People — [docs/apps/people-scenarios.md](apps/people-scenarios.md).
- Locker — [docs/apps/locker-scenarios.md](apps/locker-scenarios.md).
- Tally — [docs/apps/tally-scenarios.md](apps/tally-scenarios.md) (held with #831).

The machine-readable promotion of these tables is `tests/claims.json#appScenarios`, rendered as §3b of the nightly report.
