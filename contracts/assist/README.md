# `contracts/assist/`

The conversation surface's contracts, all derived from or checked against the app manifests (`crates/apps/<app>/manifest.json`), which are the one catalog ([#1135](https://github.com/srikanth235/centraid/issues/1135)).

| File | What it is | Written by |
| --- | --- | --- |
| `verbs.json` | The chat verb vocabulary: each verb's argument line, its past tense, whether the assistant's runtime executes it yet (`live`), an optional `kindOrder` (the order its kinds are named to the model), and the `unbacked` rows — verb rows the runtime runs that no app action backs yet, each with why. | By hand. `crates/assist/build.rs` fails the build when an action now backs an `unbacked` row, so the list only shrinks. |
| `catalog-census.csv` | One row per action (145): `app, action, verb, kind, chat_surface` as its manifest classifies it, `reachable_from_screen_today` (`yes: <KMP files under mobile/shared/src/commonMain/.../shared>` or `no`) and `reachable_from_chat_today` (`yes`/`no`). The first five columns are checked against the manifests by `crates/nativetools/tests/catalog.rs`; the last two are a measurement of the tree when the census was taken. | By hand, from the manifests, the KMP sources and the chat table before the catalog replaced it. |
| `export/` | What `nativetools export` writes: the model-facing facts, including the catalog and the declared rows. See its README. | `nativetools export` |

How the two measured columns were taken:

- **Screen**: the action's vault command (`manifest.json` → `command`) appears as a string literal in a Kotlin file under `apps/<app>/` (and `kit/tasks/` for task commands). A command several actions share (`entity.trash`, `flag.set`, `tag.add`, `edge.add`, `container.create`, …) counts only where the action's kind or verb words appear within twenty lines of the literal. It over-reports where a screen sends the same command for a sibling kind it handles in one function, and it under-reports where a screen builds a command name from parts.
- **Chat**: the action's `(kind, command)` was a row of the hand-written verb table, a field's `edit` command, or the task status path before the catalog replaced them.
