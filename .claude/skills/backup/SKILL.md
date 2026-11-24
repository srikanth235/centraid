---
name: backup
description: >-
  How do backup and the gateway work, and how do I change them? Use for the vault snapshot and tree, device state, staging, the engine and its scheduler, retention, restore and the drill, the phone's driver, the gateway crate and its protocol, and the Backup screens (the line, reasons, notices, restore entry).
---

# Backup

The phone is the vault; the gateway is a blind store for its sealed backup. "Backed up" says only what a gateway acknowledged.

The plane is specified by [`contracts/backup/spec.md`](../../../contracts/backup/spec.md) ([#1209](https://github.com/srikanth235/centraid/issues/1209)): the rulings R1 to R8, the object format, the tree, the protocol revision, the engine. Code comments cite its section numbers. The pages below say what to keep true when you change the code; the design decisions that outlive the spec (keys and signed records, the ordering rule, takeover, held deletes, the directory, read-back sampling, token storage, housekeeping) are folded into [gateway.md](gateway.md) and [phone.md](phone.md).

| If you are doing | Read |
| --- | --- |
| Deciding what backup may claim or do | [product.md](product.md) |
| The snapshot, the tree, device state, staging, the engine, retention, restore, drill, the phone's driver | [phone.md](phone.md) |
| The gateway crate, its protocol or its store | [gateway.md](gateway.md) |
| The Backup screens, the line, notices, restore entry | [screens.md](screens.md) |
| Changing the vault schema the backup census reads | [change/vault-model.md](../change/vault-model.md) |
