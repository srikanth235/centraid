---
name: product
description: >-
  The owner's product judgement for Centraid, for deciding what to build, how much, and how it should behave without asking. Use for any product, scope, UX, feature or trade-off question; "should we", "what should X do", "is this in scope", "how should this screen behave"; naming or wording anything a member reads; adding an app, screen, setting or feature; deciding what to refuse; and whenever a change touches Locker, backup or the gateway, sync and phone-store following, the on-device assistant, identity and enrollment, search, trash and deletion, or performance at scale. It states what Centraid is, the principles, the non-goals, the domain rulings, and when to stop and ask the owner.
---

# Product

Centraid is a personal, local-first superapp: one shell wraps a fixed set of first-party apps over one personal vault. It is for one person with years of data on one phone who wants no account, subscription, hosted service, or company between them and their life. The phone is the vault and its only writer; a member-controlled gateway stores only sealed backups. Twenty-four words recover everything. The owner installs Centraid; apps are not installed into it. Test an idea against year three: 90,000 photographs and 18,000 statement lines, on a mid-range phone, offline, after losing the phone.

Use the governing principles and deliberate non-goals below as settled product rulings. Apply them directly when they answer a question. Detailed domain rulings are in the files below; read the relevant one when a change touches that domain.

## Governing principles

Most rulings are one of these applied to a domain.

1. **The phone is the sole vault and sole writer.** A second writer is a conflict nobody can resolve for the member. So nothing queues for a gateway, nothing is "owner only" versus "member", and there is no peer to share with.
2. **The gateway is blind.** It holds ciphertext under keyed names and learns nothing: not content, not schema, not which vaults belong together. Any feature that needs the gateway to read, list, recognise or relay is the wrong feature.
3. **Local-first means working fully offline, not syncing well.** There is nothing to be offline from. Connectivity changes what is backed up, never what the member can do.
4. **One shell, many first-party apps, one trust boundary.** Every app is reviewed code in the release, drawn natively. Apps are not principals, hold no credentials, and cannot be granted or revoked.
5. **One owner, one id space, one mechanism per job.** One supertype for every entity, one revision history, one search index, one recurrence engine, one hash (BLAKE3), one trash model. Two mechanisms for one job is how the quieter one goes stale.
6. **Never store what you can derive.** Balances, counts, typicals, recurring charges, "backed up" are folded at read time from the real rows. A stored figure is a second truth that drifts.
7. **Failure is never shown as emptiness, and absence is never shown as health.** A read that failed, a permission that was refused, a check that was not run and a backup that was not acknowledged each say so in a sentence. An invented all-clear is the worst failure a security or backup screen can have.
8. **The member's data is theirs and survives us.** A vault outlives any build. Nothing erases a vault that holds real data to make a schema change easier. Deleting means deleting, and the UI never promises a destruction that does not exist or hides one that does.
9. **Calm, honest, concrete.** Short sentences, no exclamation, no apology, no jargon, no exception strings. The product says what happened and what to do, once, where the member first meets it.
10. **A control that does nothing is a lie.** No setting without a consumer, no tab that opens onto nothing, no tile that is always loading, no field that nothing reads. Delete it.

## Deliberate non-goals

These are decided. Do not build them, propose them in passing, or leave a hook "for later". Raising one means asking the owner to reverse a ruling, not slipping it into a change.

- **An app builder or platform.** No authoring surface, scaffolder, code store, third-party or generated app, install-from-elsewhere. The catalogue is the apps in this repo.
- **A hosted tier.** No hosted adapter, mailbox, account, plan, purchase, or S3-compatible store. The blob store is the local filesystem.
- **Sharing.** No grants, audiences, commons, subscriptions, public links or bearer-token views, and no origin that projects rows to a party the vault cannot name. A photograph leaves only as a copy handed to the operating system.
- **A second client.** No desktop shell, browser extension, paired client or remote query surface. A later desktop would be a read-only replica, never a writer.
- **A listening phone, or push.** The phone dials and never accepts. No gateway holds a push credential, because that puts a third party's delivery path inside the member's own machine. A backgrounded phone backs up in the next window the platform grants.
- **A recognition plane.** No faces, no People-in-photos, no memories, no enrichment queue or engine profiles, no "prioritise" controls. If on-device detection is ever wanted, it is proposed separately.
- **Map SDKs and tile fetches.** A tile URL is a bounding box and tells a server roughly where a member photographs. Places are drawn as a zero-egress plot of the member's own coordinates.
- **Breach checking and anything else that sends Locker data off the phone.** Weak and reused password scoring is likewise not done and is said not to be.
- **Shared expenses.** No Tally, group balances, debts or settle verbs. Money is one person's own imported statements.
- **Sample data in a member's vault.** No example vault, no sample mark, no "See an example". The first vault is the member's alone.
- **Sharing-era vocabulary on the phone.** No copy says "gateway", "queued for the vault" or "owner" to a member who is looking at their own data.
- **Compatibility with the earlier generation.** No seat files, pair tickets, npm gateway, over-the-air JS updates. Compatibility between releases of this generation is a requirement.
- **A second design language.** No separate palette, face or type scale for marketing, docs or tooling. Compose Multiplatform on iOS is also out: SwiftUI draws iOS, Compose draws Android.
- **Device farms and per-PR device minutes.** Real-device evidence is a release-cadence spend decision.

## Where the rulings are

| If the change touches | Read |
| --- | --- |
| What every app owes a member | [promises.md](promises.md) |
| The vault, Locker, identity, enrollment, what never leaves the phone | [rulings/keep-protect.md](rulings/keep-protect.md) |
| The phone's stores, imports, export, share, bytes | [rulings/arrive-take-out.md](rulings/arrive-take-out.md) |
| Trash, undo, earlier versions | [rulings/change-safely.md](rulings/change-safely.md) |
| Links, attachments, search | [rulings/connect-find.md](rulings/connect-find.md) |
| Page states, permissions, units, scale | [rulings/see-truthfully.md](rulings/see-truthfully.md) |
| Notifications, widgets, time | [rulings/be-told-glance.md](rulings/be-told-glance.md) |
| The shell, rooms, the nine apps | [rulings/home.md](rulings/home.md) |
| How a screen looks, behaves and reads | the [design](../design/SKILL.md) skill |
| Backup and the gateway | [backup/product.md](../backup/product.md) |
| The on-device assistant | [assistant/product.md](../assistant/product.md) |

## Decision process

Ask these in order. The first one that bites usually settles it.

1. **Is it a deliberate non-goal (above)?** If it is a shaped version of one (a "lightweight share", a "just this once" public link, a hosted helper), it is still the non-goal.
2. **Does it hold for a member with years of data on one phone, offline, after losing the phone?** Check the year-3 volume, the empty vault, the restored vault and the first launch.
3. **Does it leak anything to the gateway or off the phone?** Content, names, schema, coordinates, tile requests, push payloads, a listing that links vaults. If yes, the design is wrong, not the leak.
4. **Does it make the UI lie?** Emptiness for failure, health for not-checked, "backed up" for imported, zero for no data, a time the member did not choose, a destruction the app cannot perform.
5. **Does it add a second mechanism, a second truth or a second writer?** Prefer the existing door, the existing index, the existing command. Prefer deriving to storing.
6. **Does it have a producer and a consumer today?** Build for what the phone does now; delete what nothing reads.
7. **Is the member surprised?** An action says the state it wants. A copy names the thing in the member's words. A permission is asked at the moment it is needed. A guess never writes.
8. **Would the owner want this to be a bar to maintain?** A new app, setting, tab or wire number is a permanent cost. Reserve numbers rather than reusing them. Fewer places is better.

When a question survives all of these, it is a genuine product call: what the product is, who it is for, what to give up, a new surface, a change to a non-goal, anything that reverses an instinct here. Stop, write the options with a recommendation and what each costs, and put it to the owner. Do not decide it by implementing one answer. Rulings are judged on their merits for the product as it is now; if one here no longer holds, say so to the owner rather than working around it.

## Final checklist

- [ ] Not a non-goal, and not a shaped version of one.
- [ ] The phone stays the only writer; nothing queues for, relays through, or is readable by the gateway.
- [ ] Works offline, and at year-3 volume on a mid-range phone, and after a restore.
- [ ] No secret in an index, log, queue, backup in the clear, or the assistant's reach; Locker reads nothing while locked and a relock wipes.
- [ ] Every claim on screen is true: failure, partial, unchecked and unacknowledged are each said, never drawn as empty or healthy.
- [ ] Derived, not stored; one mechanism, one writer, one door.
- [ ] Time and money carry their zone and currency; no invented time or amount.
- [ ] Deleting goes through trash, with a restore path and a honest purge; backups are described as they are.
- [ ] Copy is calm, concrete, sentence case, one noun per destination, no exception text, no host or transport word.
- [ ] Every control and field has a consumer; nothing opens onto nothing.
- [ ] Writes by the assistant or an import wait for the member's tap or a preview when ambiguous.
- [ ] A genuine product call was put to the owner with options and a recommendation, not guessed.
