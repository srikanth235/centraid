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

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019fad18-4c1-1785320421-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 1165127 | 0 | 43335424 | 128617 | 1293744 | 15.6759 | 1165127 | 0 | 43335424 | 128617 | feat(blueprints): establish honest readiness and Locker auth (#630) -m governanc |
| codex-019fad18-4c1-1785320751-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 54315 | 0 | 3178496 | 8269 | 62584 | 1.0544 | 1219442 | 0 | 46513920 | 136886 | feat(blueprints): establish honest readiness and Locker auth (#630) -m governanc |
| codex-019fad18-4c1-1785323428-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 503476 | 0 | 29808128 | 79524 | 583000 | 9.9036 | 1722918 | 0 | 76322048 | 216410 | feat(blueprints): add durable lifecycle undo surfaces (#630) |
| codex-019fad18-4c1-1785323544-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 14580 | 0 | 1106944 | 2439 | 17019 | 0.3498 | 1737498 | 0 | 77428992 | 218849 | feat(blueprints): add durable lifecycle undo surfaces (#630) |
| codex-019fad18-4c1-1785324677-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 197417 | 0 | 17943552 | 31019 | 228436 | 5.4447 | 1934915 | 0 | 95372544 | 249868 | feat(mobile): add biometric trust and native Locker (#630) |
| codex-019fad18-4c1-1785325161-1 | codex | 019fad18-4c1d-7e90-b40a-442d1a0c0c40 | #630 | gpt-5.6-sol | 53070 | 0 | 3939840 | 12996 | 66066 | 1.3126 | 1987985 | 0 | 99312384 | 262864 | feat(mobile): add biometric trust and native Locker (#630) |
