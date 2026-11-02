---
name: product-intuition
description: The owner's product judgement for Centraid, for deciding what to build, how much, and how it should behave without asking. Use for any product, scope, UX, feature or trade-off question; "should we", "what should X do", "is this in scope", "how should this screen behave"; naming or wording anything a member reads; adding an app, screen, setting or feature; deciding what to refuse; and whenever a change touches Locker, backup or the gateway, sync and phone-store following, the on-device assistant, identity and enrollment, search, trash and deletion, or performance at scale. It states what Centraid is, the principles the rest follows from, the non-goals, the instincts that bite in each domain, and when to stop and ask the owner.
---

# Product intuition

Centraid is built by one owner with coding agents. Review is the scarce resource, so the product is deliberately narrow, and most "should we" questions have a short answer once you know what the product is. This skill is that answer, written as instincts. When it settles a question, act on it. When it does not, the question is a genuine product call: put it to the owner (section 12) rather than guessing.

## 1. What Centraid is, and who it is for

Centraid is a personal, local-first **superapp**: one shell wrapping a fixed set of first-party apps (Docs, Photos, Notes, People, Locker, Agenda, Money, Health, and Chat as a place in the shell) over one **vault**, a personal ontology where a person's people, money, documents and plans live once and link to each other. The owner installs Centraid, not apps into Centraid.

It is for one person with years of data on one phone who does not want an account, a subscription, a hosted service or a company between them and their life. Everything below follows from taking that person seriously:

- The phone is the vault. The Rust core on the phone is its only writer. There is exactly one authoritative copy.
- A machine the member controls, running `centraid-gateway`, holds a sealed backup and can read none of it. It is a **gateway**, not a server or a host. Member copy calls it a "backup device".
- Nothing is hosted. No account, no analytics, no Centraid-run service, no sharing plane.
- Twenty-four words recover everything. There is no kit file, password or escrow.

The test of any idea is whether it is still true for that member in year three, with 90,000 photographs and 18,000 statement lines, on a mid-range phone, offline, after losing the phone.

## 2. The governing principles

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

## 3. Deliberate non-goals

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

## 4. The vault

- **A first-party app is the owner's own screen, not a principal.** It declares what it reads and invokes at build time and a tripwire fails the build when it strays. Do not add grants, scopes a member can revoke, or an "app permissions" plane.
- **Every writer goes through the same domain operations.** Commands, imports, the assistant, a phone follower: one door, one set of invariants. If a rule lives only in one screen, it is not a rule.
- **A mechanism with no producer and no consumer leaves the schema.** Intent belongs in an issue, not in dormant DDL, a reserved column or a flag nothing reads. A wire field no table can fill is reserved or deleted.
- **Identity is never taken from a value.** Two documents with identical bytes are two documents with independent histories. A drive row is the document wrapper, never the content hash. A merchant is not a person.
- **Time is the member's.** Civil time is the vault's zone and the device's stated zone, never the host's and never UTC by default. A date-only task or reminder stays a date and never gains an invented time. A line on a statement keeps the printed day, so a trip across time zones moves nothing between months.
- **Money keeps its currency.** An amount has no meaning without one. A base-currency total is an explicit valuation with a rate and a source, and says "unavailable" when the rate is missing.
- **Deleting has a model.** Trash first, restorable until the launch pass empties it, then purged. A holder (notebook, folder, project, account, person, list) takes its members with it and brings back only the ones it took. A person's purge never destroys other people's records. A purge that cannot proceed refuses with a sentence naming why.
- **Edits are one move, not a toggle.** Complete and reopen are separate commands. An editor autosaves when typing stops; Cancel exists only before the first keystroke. A save that fails after the member left is told on Home, never logged and lost.
- **The vault keeps no record of what the member asked for.** No activity feed, no journal of typed words that survives "Delete forever". It keeps only what it needs to avoid doing a thing twice and to tell which copy is ahead.

## 5. Locker

Locker is the one place where reading is itself the sensitive act. It is deliberately austere.

- **Nothing inside Locker is read while it is locked, and a relock is a wipe.** Every Locker machine reads only while the gate is open, answers that land after a relock are dropped, and closing drops every revealed value and typed draft. The core's metadata list is plaintext by design (listing is not unlocking), so the wall is the shell's and it must hold.
- **The list is metadata; the secret is not.** Sealed values (password, one-time seed, card number, CVV, secure-note content, sealed custom fields, passkey keys) are sealed at rest and never enter a search index, a log, a queue, a backup in the clear, or the assistant's reach. They reach the screen only through an authorised reveal.
- **Search finds a Locker item by its plain fields whether or not Locker is locked; opening the result goes behind the wall.** The Home tile counts items and shows none, and reads "Locked" or "Open".
- **The assistant works on Locker like the owner, except it never reveals or writes a sealed value.** Such a request ends in a decline. It may help with what a login is called and where it is filed, and has no business with the secret.
- **The phone is the unlock boundary.** Biometric with the passcode as fallback, relock when Centraid leaves the foreground, no separate Locker passphrase. Only the phone refusing the member counts as a failed unlock; a cancel does not. The wall says how many failed and when.
- **The key lives only in memory.** It derives from the 24 words, is zeroed on relock and is written nowhere. No gateway holds, mints or hands out a member key, and a "reveal" request is unrepresentable on that path rather than checked.
- **No history of reads, no recently-used shelf.** The only trace is each item's "Last used" stamp. A shelf of recent items would publish reading habits on the screen where reading is sensitive.
- **Never an invented all-clear.** Review shows what is known from metadata (flagged compromised, `http://` addresses, cards expired or expiring) and says what it did not check. Compromised is a flag the member sets.
- **Nothing leaves silently.** Export is plaintext to the OS save sheet only, after a confirm and a fresh owner check, receipted before any secret opens. A copied secret is cleared when the member locks. An open Locker is shielded from capture.
- **A secret saved mid-typing is a wrong secret.** Locker's editor saves on an explicit Save, and leaving with changes asks first. A password generator is unbiased and uses no look-alike characters.
- **The passkey slot is storage.** It is shown, renamed and removed; its key is never revealed, copied or exported.

## 6. Backup and the gateway

- **"Backed up" says only what a gateway acknowledged.** "Backed up 2 minutes ago" needs the records acknowledged and every content hash confirmed. Records acknowledged with items waiting say so, with the count and the reason. Nothing acknowledged reads "Not backed up". Never claim continuous backup: it is foreground work plus the windows the OS grants, and a force-quit stops it until next launch.
- **The phone dials; the gateway never reaches in.** Direct HTTPS to a machine the member controls, pinning the certificate whose fingerprint the pairing QR carried. No relay, no listing endpoint, no accept loop, no pairing lane on the phone.
- **Everything is sealed on the phone before it leaves.** Names are keyed so a gateway cannot recognise a known file. A gateway has no endpoint that lists vaults: a restoring phone derives its addresses from the 24 words and probes, because a listing would link a member's vaults to each other.
- **Backing up never changes what the member can do.** Backup copies the whole vault page for page, never a sanitised copy. A vault is held for a snapshot's copy and never across the network.
- **More than one gateway from day one.** The second one elsewhere is the off-site copy. Forgetting a gateway asks no confirmation: it forgets this phone's side only, never what the gateway holds, and pairing again undoes it.
- **A refusal is an answer, not an absence.** A gateway that says disk full, over quota or too large stops the pass and the Backup screen names it. A part is never skipped, because skipping let "backed up" read true over a hole.
- **One writer at a time, provably.** A restore or takeover claims the next writer position; the superseded phone freezes and says so. A restore never touches a vault this phone already holds. Restoring checks everything before it claims.
- **Deletion is honest about backups.** A photograph deleted forever stays sealed on the gateway for the retention horizon. A restore, a retention period and "free up space" all count only what was actually acknowledged and is not kept by an album or otherwise rented.
- **The member's transfer rule is one setting.** Wi-Fi only by default, cellular for photographs optionally, manual on request. A video original never crosses a metered link under any rule. A tap on "Back up now" sends records over a metered link, never a heavy original.
- **iOS keeps the vault out of the OS backup.** Every vault-derived path is excluded; the seed in the synced keychain is not, because it is end-to-end encrypted and is what makes a lost phone recoverable.

## 7. Sync, following and the byte plane

- **There is no sync between devices.** One authoritative file, sealed backups, restore whole. Do not add a replica log, outbox, conflict-resolution UI or "last device wins" semantics.
- **The phone's own stores stay the source and are followed one way, into the vault.** Contacts, Calendar, the camera roll, a picked folder and the health store are read; nothing is ever written back. Health asks for read permission only.
- **A follower reports what it read, and the vault merges.** One three-way rule (what the source stated, what the vault holds, what is new) serves every source: a member's own edit always wins over a refresh, and the source's words are kept as evidence.
- **An incomplete read trashes nothing.** A refused permission, limited access or failed query is "doubted": it reports and changes nothing. A complete read that loses most of what it followed is also doubted and does not ask the member. A row gone from a complete read goes to trash if the member never touched it, otherwise only its link is forgotten.
- **A record is linked by the most durable id the phone offers and says which kind it is,** so a new phone re-finds a record instead of duplicating it. The member is told what to do (add the account in the phone's Settings), never a platform path.
- **Photos keeps what the camera roll deletes.** The vault is the photograph's backup. Camera-roll import is automatic once access is granted: no first-run offer, no per-selection "Back up". Importing is "import"; only a gateway acknowledgement is "backed up".
- **Free up space is offered only where the system confirms the deletion,** and frees only what a gateway acknowledged and no kept album holds. Bytes no gateway has acknowledged are never evictable.
- **An edited photograph is a new photograph** with the original named as its source, carrying the original's moment. The original is never touched. A re-offered photograph commits once.
- **Bytes never cross the shell boundary as payloads.** The core materialises a blob to a path; a shell never declares a digest, it streams bytes and the core names them.

## 8. The assistant

- **It runs on the phone, with a model the release pins.** Nothing the member says leaves the device. No cloud model, no "latest" model, no fetched weights outside the pinned asset.
- **Every write parks behind a confirm card and runs only on the member's tap.** A turn that writes more than once shows the whole chain before anything runs. Relaxing this needs evidence that a class of writes never misfires. A guess must never write.
- **The model judges; the harness composes.** The model emits intent and referents; the harness grounds names, resolves dates, applies conventions, validates before executing and keeps focus. Reads and errors name their repair. Do not push product rules into prompts or training data when the runtime can hold them once.
- **It says what it cannot do.** Out of scope gets a short honest decline. It does not invent a state the vault does not have (there is no "in progress" task). Health is off for Chat until the member grants it.
- **A chat is vault data.** Backed up sealed with the vault, per vault, deletable, permanently and per chat. Deleting a chat leaves nothing of the conversation, card titles or thumbnail behind. Thread titles are the member's first question, trimmed; the model does not write them.
- **A card is a snapshot with no foreign key.** At the tap the shell asks whether the row is still there and says "This item is gone." when it is not. A turn is one commit; an in-flight turn is lost, never half-kept.
- **Evaluation is honest.** One model counts, scored by one script on frozen, world-disjoint sets under greedy decoding. A number the box cannot prove is named, not asserted. Do not fit the test set.
- **Ask-about is the no-match offer.** Every searching app's empty result offers "Ask about “x”" except Locker, which never offers it.

## 9. Apps

- **Agenda is the one app for a member's days.** Tasks is a vault domain, not a launchable app. A dated task is a row in its day; overdue work is a group with one verb ("Reschedule"); the add sheet switches between Event and Task and remembers the last choice. The Agenda tile stays small and a failed tasks read drops the due line and never refuses the tile.
- **Recurrence has one engine.** A change of timing is for one day. Guests, reminders, links and calendar belong to the whole event. "This and the following" is a row of its own. Cancelling is always confirmed on the phone and then executes.
- **Notes are words, not databases.** Autosave, a blank title is shown as the first line of the body, a body that is not on this phone is read-only so typing never silently overwrites what the member never saw. `[[` links only to what a title can resolve to. A notebook is a place reached by tapping Notebooks, never a band tab.
- **People is a circle of people, not a CRM.** Relatives are people. Relationships read from both sides. A birthday is the person's own date with its reminder always on; a gift idea is a task about the person. A person holds what is written about them alone. No avatar colour picker: a hue is derived from the id.
- **Docs holds documents the member owns.** Folders are labels, not places, and may repeat a name. "Delete forever" and "Empty trash" really destroy. A document's history is its versions; there is no activity rail.
- **Photos names places honestly.** A place is named by a ladder (a name the member gave, an offline settlement name, a phrase relative to a named place, then "A place with no name yet") and a bare coordinate is never printed as a name. A relative phrase ("3.4 km NE of Home") never leaves the phone in a title a card or export carries. Places is a facet of Photos, not an app. No face surfaces, no duplicate hunting.
- **Money is a ledger of imported statements.** Imported lines are never edited except their category and a one-way void. A date order the file cannot decide is a question, never a guess. Fuzzy duplicate and transfer detection only propose and never write. Recurring charges are detected, not stored. Categories are one stable scheme. Rules name payees; the bank's words are kept as evidence.
- **Health follows the phone's store, one way.** Today compares whole days to the member's own typical range, never a target. On a connected day with no steps yet the tile says "Nothing yet today", never 0. Figures are computed in Rust.
- **Home is the vault and its backup.** The header's one line is the backup line. Every launchable app is a tile. Search covers every app, Locker included. Home carries no sample notice and no "fill this out".
- **Empty states teach or import; they never decorate.** Where the phone already holds the data, offer a one-tap import at the point of use. A first vault gets a few teaching starter rows only where there is no import, and each is trashable.
- **A new app is a bar the owner sets.** It needs a north star (one product whose functional depth it matches), an identity hue, a place on the ring, a row in the roster, a manifest of what it reads and invokes, and year-3 evidence. Do not add one without the owner.

## 10. The mobile shell and design

- **Rust owns every durable fact and every derived read. Views decide nothing.** Every label, sentence, chip, enabled flag and empty-state choice is computed in the shared machine. A field a view needs and Rust does not carry is a Rust gap, never a computation in Kotlin or Swift. Both shells reach parity or the parity register says why.
- **The band is places, not features.** Two to four destinations then More; More holds secondary places and actions only. Search is a bar under the title, not a tab. Filters and sort are one chip row under search. The header has one trailing action: the app's create verb. The shell band lists Home, Chat and Backup, never an installed app.
- **Content pushes; decisions sheet.** A destination the member reads is a pushed page with a real back target; a choice is a sheet. Editors hide the band. Media is a full-bleed room of its own.
- **Trash is per app and never promises a destruction that does not exist.** An app with a destroy command offers Empty trash behind the outlined confirm; an app without one offers restore only.
- **Copy is a contract.** Calm, concrete, confident, short, sentence case ("Photo deleted", not "Your photo has been successfully deleted"). One noun per destination and the screen title wins. No exception string is ever shown; the core builds the sentence from a code. State each ontology fact once, where the member first meets it.
- **The shell takes no brand colour.** Ink on paper. An app's identity hue lives in its icon chip and as a content marker. Commit is the Ink button, destructive is an outlined button in the net colour, at most one filled ink element per view.
- **One feedback grammar.** State is one status line docked above the band. No toast, badge count, red dot, bounce or parallax. A load is a skeleton, not a spinner. Pressed is the one interaction state. The one haptic is a selection tick; a success haptic fires when the write resolves, never at the tap.
- **Chrome is the platform's.** Headers and tab bars are the platform's own, glass on iOS. One row height of 44, page margin of 18, text follows the system size within a cap, text in a fixed-height box is clamped never clipped.
- **Ask for permissions at the moment of need, never at launch,** and leave an actionable path to Settings after a denial. Quick add routes unambiguous input deterministically; ambiguous input shows a preview and commits nothing until confirmed.
- **Member-facing screens name no host, transport or engine state.** A gateway is named only where the member manages one. The vault lockup says where the vault stands, derived and never stored.
- **A save that matters is told.** A create ends its sitting so a double-tap cannot create twice. A write that cannot land says so with what to do ("<title>. Try again.").

## 11. Identity, enrollment, search, performance

**Identity and enrollment**

- **One owner per vault, no roles, no password, no session.** A device is proved by its key. Enrollment is full trust: no companion tier or per-device attenuation.
- **The 24 words are the only recovery.** A fresh phone mints them in the core, shows them at once on a secure screen, and the shell has no word list or checksum. A restore takes the words or the seed, exactly one. A comparison number (safety number), never a hex id, is what the member verifies at pairing.
- **A member can read their words again on this phone,** and can keep a vault on its own words by opting in. Refusals never quote a word.
- **Keys cross the boundary borrowed and are written nowhere by the core.** The seed lives in the platform's secure store; absent seed is a state, not a fault.

**Search**

- **One index, found the way a person types.** Every typed or labelling text column is findable. A trashed entity leaves the index. Fuzzy matching corrects to a whole word the vault holds, never an invented one, and says "Including results for “…”" when it did. A line from 2019 is as findable as one from this month.
- **Search never reads a secret.** Locker's sealed cells, passkey keys and the assistant's own words are never indexed. A chat is found by its title and the member's words only.
- **Search is the vault's, not the phone's.** No client substring matching, no per-app engine. Closing search clears the term and the answer.

**Performance and scale**

- **Declare year-3 volume and measure at it.** A feature is fast on an empty vault by accident. Reads page by keyset, never offset; bounds must be exercised by their scale profile or they are unproven. Search has a per-call budget at year-3 scale.
- **A performance design is adopted only on evidence** from the journey ledger at the owner's volume on the owner's hardware. An emulator number never becomes a ceiling.
- **A cap never names a size it cannot reach,** and a page never silently drops rows (undated photographs, nullable sort keys). If it cannot fit in a commit, it is owed and done when idle.

## 12. How to decide something new

Ask these in order. The first one that bites usually settles it.

1. **Is it a non-goal (section 3)?** If it is a shaped version of one (a "lightweight share", a "just this once" public link, a hosted helper), it is still the non-goal.
2. **Does it hold for a member with years of data on one phone, offline, after losing the phone?** Check the year-3 volume, the empty vault, the restored vault and the first launch.
3. **Does it leak anything to the gateway or off the phone?** Content, names, schema, coordinates, tile requests, push payloads, a listing that links vaults. If yes, the design is wrong, not the leak.
4. **Does it make the UI lie?** Emptiness for failure, health for not-checked, "backed up" for imported, zero for no data, a time the member did not choose, a destruction the app cannot perform.
5. **Does it add a second mechanism, a second truth or a second writer?** Prefer the existing door, the existing index, the existing command. Prefer deriving to storing.
6. **Does it have a producer and a consumer today?** Build for what the phone does now; delete what nothing reads.
7. **Is the member surprised?** An action says the state it wants. A copy names the thing in the member's words. A permission is asked at the moment it is needed. A guess never writes.
8. **Would the owner want this to be a bar to maintain?** A new app, setting, tab or wire number is a permanent cost. Reserve numbers rather than reusing them. Fewer places is better.

When a question survives all of these, it is a genuine product call: what the product is, who it is for, what to give up, a new surface, a change to a non-goal, anything that reverses an instinct here. Stop, write the options with a recommendation and what each costs, and put it to the owner. Do not decide it by implementing one answer. Rulings are judged on their merits for the product as it is now; if one here no longer holds, say so to the owner rather than working around it.

## 13. Final checklist

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
