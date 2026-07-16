# Conversation memory model (v0)

Status: implemented (issue #424). This records the deliberate v0 decision and
the silent-drop behavior it replaces.

## The model

The conversation engine keeps **no model-facing history of its own**. What the
model remembers across turns is delegated entirely to the runner adapter's
opaque **resume handle** — `Conversation.adapterKind` + `adapterSessionId`
(`packages/app-engine/src/conversation/schema.ts`). Resume it and the backend
(codex thread / Claude session) continues where it left off; drop it and the
backend starts blank.

The **ledger** (`turns` / `items`) is a **UI codec**. `getSession`
reconstructs the *rendered* transcript from it for display, export, and search.
It is **never** replayed into the model as a prompt. So the rendered transcript
and the model's actual memory are two different things that can diverge.

## Runner kind pins at the first turn; the pin wins

Runner prefs (`agent.runner.*`) are loaded per turn. A conversation's runner
kind **pins** the first time a turn lands (`noteTurn` records `adapterKind`).
Every later turn runs with that pinned kind regardless of the user's *current*
prefs (`makeConversationRunnerCore` overrides `prefs.kind` — and only `kind` —
when `prevAdapterKind` is set). A mid-thread prefs flip therefore keeps the
conversation on its original backend and **loses no context**; prefs changes
steer only **new** conversations.

This replaces the old behavior: a mid-thread runner switch dropped the resume
handle, so the new backend started a virgin thread and all prior context
silently vanished from the model's point of view while the UI transcript still
rendered in full.

## Lost handles are made visible (A1)

The one remaining fresh-context reset is a **lost / expired handle** (pinned
kind, but no `adapterSessionId`). That turn runs blank, and the runner emits a
persisted `notice` (`code: 'context.reset'`, level `warn`) so the reset is
surfaced instead of silent. Notices are stored on `turns.notices` (JSON) and
replayed on reload by `buildReplayEvents` / `getSession`, rendered by both the
React shell and the kit Ask panel.

## Deferred upgrade (issue #424 option B)

Reconstructing lost context from the ledger and re-priming a fresh backend
thread is designed but **not** built for v0. When it lands, the `context.reset`
notice becomes the seam where a rehydrated summary is injected.
