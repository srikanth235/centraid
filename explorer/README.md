# The Sovereign Isle — Centraid Explorer

An interactive, self-contained 3D world that teaches how Centraid works: **one person's vault is a floating isle at dusk**. Every landmark maps 1:1 to a real component — the vault drum whose light leaks only at the seams the DEK controls, the ledger archive as a giant open book, the harness row of installed CLIs, device islets joined by tether-threads, and exactly one red thread leaving for the backup warehouse.

Vanilla three.js (vendored, no CDN, no build step, no network). Opens from `file://` — double-click `index.html`.

## Open locally

```
open explorer/index.html
# or
python3 -m http.server -d explorer 4174 && open http://localhost:4174
```

Controls: drag orbits · wheel zooms · `←`/`→` step beats · `Esc` overview · `X` cycles detail · `▶ PLAY` autoplays · deep links `#j/<journey>/<beat>` · `prefers-reduced-motion` respected.

## Progressive disclosure

Three detail modes (cycle with the X-RAY button): **STORY** — pure metaphor, no labels; **MECH** — small labels appear only near the camera's focus; **FULL** — everything. The overview always speaks in STORY; entering a journey restores your mode. Labels never overlap (greedy collision avoidance, major beats small).

## Journeys (each beat cites its repo source)

1. **THE ISLE** — one owner per isle; four seats through one gate code.
2. **FIRST LIGHT** — bootstrapping: blank dataDir → auto-founding → keys/ → the one-owner invariant → first device enrolls. The isle builds itself.
3. **A MESSAGE** — conversation ⊃ turn ⊃ item, inked in the ledger; then the same machinery run by an automation script.
4. **PAIR A SEAT** — ticket ceremony → enrollment binds device to owner → consent-shaped replica bootstrap.
5. **HARNESS ROW** — turns reach models through installed CLIs over ACP; TurnPlane.runTurn; resume handles; adapters; consent-keyed provider egress.
6. **A PHOTO** — CAS cellar → shaped deltas → consent-gated faces → sealed crates on the one red thread.
7. **MOBILE OFFLINE** — four mounted scopes; honest partial bootstrap; durable intents; the status grammar; when sync actually runs; scoped revocation; storage budgets; the Locker exception.
8. **CONSENT DESK** — the vault register; executed/parked/denied with receipts.
9. **COMMONS** — grants, residency, the steward's monotonic log.
10. **STOLEN DISK** — the isle at night: every on-disk slot and what a copy without custody yields; why the kit password is load-bearing.

## The mapping table

The honesty contract: nothing is drawn that isn't in this list. Rendered live in-app under **MAPPING**; the rule is — when story and mechanism conflict, the mechanism wins and the metaphor changes.

| World element | Real thing | Source |
| --- | --- | --- |
| The isle | One person's vault — self-contained, visible edge | ARCHITECTURE.md |
| Vault drum; dark vs lit cells; DEK seams | vault.db — sealed vs plain columns; the sealing boundary | at-rest table (#555) |
| Key cabinet + orbiting keyring | keys/ KeyStore; endpoint identity, keyring, per-vault DEKs | at-rest table |
| Gatehouse + portcullis | Gateway HTTP surface — the only door in | ARCHITECTURE.md |
| Consent desk arch + three lamps | Consent pipeline — executed/parked/denied + receipt | #286 |
| Ledger archive (open book, inked rows) | journal.db — conversation ⊃ turn ⊃ item, never erased | runtime model |
| Harness row sheds + ACP ring | Installed CLIs (codex, claude-code, opencode) over ACP; TurnPlane.runTurn | ARCHITECTURE.md; docs/harnesses.md |
| Violet egress thread | Provider egress — consent-keyed, computed class | egress-consent |
| Automation hall gears | Cron/webhook fire spine; a tick is message_in ordinal 0 | runtime model |
| Blob cellar (identical crates) | Content-addressed CAS — a blob has no identity but its hash | SECURITY.md v0 premise |
| Avenues through the vault plinth | Every data touch crosses the vault | tool surface docs |
| Bridge + device islets | iroh QUIC tunnel; each seat its own ground | packages/tunnel |
| Relay beacon | Browsers have no UDP — web PWA is relay-only | ARCHITECTURE.md |
| Scope stacks on the phone islet | Up to four mounted vault replicas, one SQLite read plane | docs/mobile-offline.md |
| Queued parcels at the phone | Durable intent outbox; replica ⊕ outbox overlay | docs/mobile-offline.md |
| Cut thread | Offline: reads from replica, writes queue as intents | docs/mobile-offline.md |
| Red thread + sealed crates | Backup snapshots sealed with the keyring — the one egress | at-rest table |
| Recovery chest | Wrapped kit — password = custody | #603 |
| Eight rim pavilions | The eight system apps, each in its identity hue | packages/blueprints |
| Commons circle + table + steward spire | share_circle_grant; steward orders share_commons_op | #731 |
| Night mode | The stolen-disk thought experiment | at-rest table; SECURITY.md |

## Updating when the architecture changes

This artifact is a doc; stale scenes are bugs.

- World geometry: `js/isle.js` (landmarks, MAP chips, ANCHORS, FOCI, the ISLE api). Journey content: `js/journeys.js` (beats, narration, fx). Beat player: `js/engine.js`. Each beat cites its source doc — update or cut when the doc changes. Vocabulary is binding: conversation ⊃ turn ⊃ item; never "chat" for the ledger. Code wins over docs; unsure details are cut, not guessed.
- `js/three.min.js` is vendored (r1xx, classic-script build) — replace it in place if ever needed; nothing else may add a dependency.

## Shipping location (proposed)

Self-contained static directory. To fold into the docs surface, add one line to `scripts/docs-site/assemble.mjs` next to the other `cp` calls:

```mjs
await cp(path.join(repoRoot, "explorer"), path.join(siteDir, "explorer"), {
  recursive: true,
});
```

which serves it at `/explorer/` alongside `/docs/` and `/city/`.
