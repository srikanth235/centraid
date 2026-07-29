## Accounting

<!-- Implementation checkpoint: Wave 0 measurement/honesty and the Locker
trust boundary are complete locally; the full waved receipt narrative and
fresh-context audit will be written only when issue #630's one exit is met. -->

<!-- Checkpoint: P5 now provides durable one-shot revisions, trash/restore,
and reachable history/undo surfaces for Notes, People, Tally, and Photos;
People/Tally formerly dead mutation handlers are reachable, and backup plus
restore-after-erase tests preserve lifecycle and revision rows exactly. -->

<!-- Checkpoint: mobile now has an optional biometric whole-app gate that
unmounts the replica and clears credential memory on background, plus a
first-class native Locker cover using online-only passphrase/device
authentication, per-item permits, switcher masking, and timed clipboard
clearing. -->

<!-- Checkpoint: Wave 1 untrusted-content hardening now has the shared
13-vector corpus running through a real render component from all eight apps,
scheme/MIME allowlists on dynamic link/media/document/CSS sinks, and a
fail-before-draft importer corpus for malformed base64/UTF encodings,
truncated ICS/vCard, spreadsheet-formula CSV cells, unsafe/truncated ZIPs, and
archive-bomb declarations. Ambiguity decision: formula-prefixed values are
rejected in display-bearing CSV fields instead of being silently mutated;
password cells remain byte-for-byte arbitrary secret data. -->

<!-- Checkpoint: Wave 2 makes handler reachability and state honesty permanent.
All manifested actions/queries now require a web and mobile caller or a
rationale-bearing agent/extension/platform fallback. Mobile treats a missing
session as unavailable, combines per-query errors, exposes freshness and pull
refresh across all three covers and every Photos sub-screen, separates queued
offline writes from parked approval intents, assigns stable double-tap intent
IDs, validates optimistic mutations at enqueue, and surfaces every write
outcome. Docs and Photos entity writes are optimistic. Design decision:
document/photo upload and cross-vault placement are not represented by
fabricated canonical rows before content IDs exist; their existing durable
upload/placement queues and progress surfaces are the honest optimistic
contract. Enrichment requests likewise surface their queue admission without
inventing an entity. Web now has first-read skeletons and actionable empty
states in every blueprint, all consent banners open the Vault permission pane
directly, and the shell exposes persistent connectivity/sync state plus a real
search/no-results path. Verification at this checkpoint: Blueprints 648,
Client 1,438, and Mobile 268 tests pass; all three package typechecks and the
mobile import-boundary lint pass. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019fad18-4c1-1785320421-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 1165127 | 0 | 43335424 | 128617 | 1293744 | 15.6759 | 1165127 | 0 | 43335424 | 128617 | feat(blueprints): establish honest readiness and Locker auth (#630) -m governanc |
| codex-019fad18-4c1-1785320751-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 54315 | 0 | 3178496 | 8269 | 62584 | 1.0544 | 1219442 | 0 | 46513920 | 136886 | feat(blueprints): establish honest readiness and Locker auth (#630) -m governanc |
| codex-019fad18-4c1-1785323428-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 503476 | 0 | 29808128 | 79524 | 583000 | 9.9036 | 1722918 | 0 | 76322048 | 216410 | feat(blueprints): add durable lifecycle undo surfaces (#630) |
| codex-019fad18-4c1-1785323544-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 14580 | 0 | 1106944 | 2439 | 17019 | 0.3498 | 1737498 | 0 | 77428992 | 218849 | feat(blueprints): add durable lifecycle undo surfaces (#630) |
| codex-019fad18-4c1-1785324677-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 197417 | 0 | 17943552 | 31019 | 228436 | 5.4447 | 1934915 | 0 | 95372544 | 249868 | feat(mobile): add biometric trust and native Locker (#630) |
| codex-019fad18-4c1-1785325161-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 53070 | 0 | 3939840 | 12996 | 66066 | 1.3126 | 1987985 | 0 | 99312384 | 262864 | feat(mobile): add biometric trust and native Locker (#630) |
| codex-019fad18-4c1-1785326824-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 390749 | 0 | 14336000 | 45157 | 435906 | 5.2382 | 2378734 | 0 | 113648384 | 308021 | feat(security): harden blueprint content and imports (#630) |
| codex-019fad18-4c1-1785326867-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 10334 | 0 | 326912 | 509 | 10843 | 0.1152 | 2389068 | 0 | 113975296 | 308530 | feat(security): harden blueprint content and imports (#630) |
| codex-019fad18-4c1-1785326903-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 2342 | 0 | 225792 | 161 | 2503 | 0.0647 | 2391410 | 0 | 114201088 | 308691 | feat(security): harden blueprint content and imports (#630) |
| codex-019fad18-4c1-1785326968-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 2336 | 0 | 226816 | 270 | 2606 | 0.0666 | 2393746 | 0 | 114427904 | 308961 | feat(security): harden blueprint content and imports (#630) |
| codex-019fad18-4c1-1785329594-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 559681 | 0 | 31398400 | 75630 | 635311 | 10.3833 | 2953427 | 0 | 145826304 | 384591 | feat(blueprints): make offline state honest and reachable (#630) |
