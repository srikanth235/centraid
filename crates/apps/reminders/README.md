# `crates/apps/reminders` — tasks and lists

Reminders is **10 manifest queries and 19 actions**. It was the second half of Agenda until round 10 of #1173: Calendar (`crates/apps/calendar`) owns events and invites; this crate owns tasks and their containers (lists, projects, sections, areas) and never touches an event (`manifest.rs` tests that the manifest declares no event or occurrence scope and no `event.*` command).

## What is here

| File | What it owns |
| --- | --- |
| `manifest.json` | the app's manifest: queries, actions and scopes |
| `src/manifest.rs` | the parse, and the claims the manifest makes about itself |
| `src/task/` | the reads: the board (a bounded window of the newest open tasks plus the logbook), one task, the projects, catch-up, the reminders the notification service schedules from, the trash, the smart counts and the earliest-due rows, with the civil-time placement of every due in the zone the device states |
| `src/nl_date.rs` | the natural-language dates a quick add understands (`tomorrow 9am`, `every monday`) |
| `src/attachments.rs` | `load_attachments` for a task: the kit's page, asked of this app's kind only |
| `src/commands.rs` | the nineteen actions, as a table of command invocations |

Completion is the vault's one operation (`task.complete`), shared with People and automations; a repeating task never stacks, and no module-level ceiling bounds a read but the caller's `limit`.
