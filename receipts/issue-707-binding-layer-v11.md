# issue-707 — Binding layer v11: Notifications, Vault and Settings

GitHub issue: [#707](https://github.com/srikanth235/centraid/issues/707)

Umbrella receipt. The v11 design handoff rebuilt three surfaces against the
functional inventory in #707; this pass integrates that handoff on top of the
#814 Settings reshape (PR #815). Worked by root-agent orchestration: one
foundation slice, then Settings, Notifications and Vault slices on separate
sub-agents, integrated at the seams by the root.

## Checklist

- [x] Shared blocks: SectionBlock Show/Hide toggle, RowsBlock struck rows and stacked groups
- [x] Notifications: every blocking decision is a card (DecideBlock), with in-place confirms
- [x] Notifications: held tray — a refresh never discards in-progress member state
- [x] Notifications: on-record sections disclose, open on pointer, closed on touch
- [x] Notifications: old-gateway and write-refused states say what is true
- [x] Vault: atlas and household resolve to one custody surface, three sections in question order
- [x] Vault: census meter rows; never-written kinds stated, not buttoned
- [x] Vault: custody line states records, full copies, devices enrolled from one derivation
- [x] Settings: enrichment ceiling control removed; egress stated, never set
- [x] Settings: reasoning level bound to the model, clamped on change, inert when absent
- [x] Settings: every pref write surfaces the gateway's own text and rolls back

## Deliberate divergences from the handoff prototype

Each holds a repo invariant over the prototype's literal drawing:

- `[Do it]` confirms are outlined `--net`, never filled (DESIGN.md invariant 3).
- Collapsed decision cards offer only Review; one filled element per view.
- Parked eyebrow names the caller, not a tier — the wire carries no tier.
- No harness Connect flow — detection is CLI-side; the card states the install hint.
- Inheriting lanes keep independent model/effort overrides the prototype's fixture lacked.
- The foot stamp states only what the build can vouch for: app version and gateway host.
- Gateways/Edges/Commons still render via SharingCard inside "Where it lives" — its
  rewrite is a follow-on slice, declared rather than half-done.
- Badge count feeds app bar meta and the status line, never the launcher (invariant 5).

## User impact

Notifications: a blocking decision is now a card that states its actor, its
artifact and its consequence in place, and an irreversible verb confirms where
it acts. Nothing a member is part-way through — an edit, a ticked always-allow,
an open confirm — is ever discarded by a background refresh; new arrivals hold
in a Live tray until added. Vault answers the custody questions in order: what
the vault holds, who can reach it, where it lives, with one set of numbers.
Settings stops offering a choice that does not exist (where enrichment runs)
and states egress instead; every failed write returns the gateway's own words
and puts the control back where the gateway has it.

First-run: opening Notifications remains the consent moment for web push;
Vault's sections open on a pointer and arrive collapsed on touch; the
Enrichment page's first paint reads switch state from the gateway's one
resolver. Evidence: artifacts/e2e/ui-impact/issue-814-enrichment-capabilities.png
(emitted by apps/desktop/tests/e2e/settings-enrichment.spec.ts).

## Verification

- `packages/client`: full vitest run green (247 files / 2276 tests at slice
  landing; re-run at integration).
- Repo `bun run typecheck`: 25/25 tasks.
- Gates run green per slice: `lint:css`, `lint:design-tokens`, `lint:type-floor`,
  `lint:logical-insets`, `lint:hairline`, `lint:container-opacity`,
  `lint:aria-labels`, `lint:motion-rule`, `test:qualities`, `knip`,
  `format:check`. `test:hygiene-ratchet` overage found at integration and
  fixed by strengthening spy assertions, not by raising the budget.

## Open follow-ons

- SharingCard regrouping into Gateways / Edges / Commons row groups.
- Mobile still renders the v9 approvals row model; promote DecideBlock's
  contracts into `@centraid/design/blocks` when the phone grows decision cards.
- Unifying the `atlas`/`household` pin keys is a pin-set migration, not a rename.
- Per-model reasoning-level metadata needs a wire change (noted in
  docs/harnesses.md).
