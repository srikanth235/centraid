# Backup, following, and the assistant

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
