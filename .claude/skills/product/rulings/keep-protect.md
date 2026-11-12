# Keep and protect

The vault, Locker, who may open what, and what never leaves the phone.

## 4. The vault

- **A first-party app is the owner's own screen, not a principal.** It declares what it reads and invokes at build time and a tripwire fails the build when it strays. Do not add grants, scopes a member can revoke, or an "app permissions" plane.
- **Every writer goes through the same domain operations.** Commands, imports, the assistant, a phone follower: one door, one set of invariants. If a rule lives only in one screen, it is not a rule.
- **A mechanism with no producer and no consumer leaves the schema.** Intent belongs in an issue, not in dormant DDL, a reserved column or a flag nothing reads. A wire field no table can fill is reserved or deleted.
- **Identity is never taken from a value.** Two documents with identical bytes are two documents with independent histories. A drive row is the document wrapper, never the content hash. A merchant is not a person.
- **The vault keeps no record of what the member asked for.** No activity feed, no journal of typed words that survives "Delete forever". It keeps only what it needs to avoid doing a thing twice and to tell which copy is ahead.

## 5. Locker

Locker is the one place where reading is itself the sensitive act. It is deliberately austere.

- **Nothing inside Locker is read while it is locked, and a relock is a wipe.** Every Locker machine reads only while the gate is open, answers that land after a relock are dropped, and closing drops every revealed value and typed draft. Leaving Locker before answering the phone's prompt (back to Home, another tab, a relock) drops the pending unlock and asks the shell to take the prompt down (`OwnerCheck.cancel`: `LAContext.invalidate()`, `BiometricPrompt.cancelAuthentication()`), so Face ID never stays over Home; the answer that lands afterwards is ignored. The core's metadata list is plaintext by design (listing is not unlocking), so the wall is the shell's and it must hold.
- **The list is metadata; the secret is not.** Sealed values (password, one-time seed, card number, CVV, secure-note content, sealed custom fields, passkey keys) are sealed at rest and never enter a search index, a log, a queue, a backup in the clear, or the assistant's reach. They reach the screen only through an authorised reveal.
- **A changed secret keeps its earlier value, sealed.** Locker's Earlier versions lists a changed password, card number, CVV, note or sealed field as a masked row ("Password changed", dots) with a Reveal behind the same owner check the live reveal asks for, and restoring that version restores the sealed value. The full preview of such a version shows each secret as dots with no Reveal (the list has it), and a shut wall draws the gate and reads nothing. The vault keeps only the `lk1:` ciphertext, never a plaintext. A one-time-code seed comes back with a restore but is never revealed, in history or live; a passkey's key is kept nowhere.
- **A Locker item may be linked to an account, a place and a person, and to a person it is `with`.** These are plain links, never a sealed value: an edge's label and anchor carry no ciphertext (the command refuses one), and the edge that starts or ends at an item is hidden from every door that is not Locker's, so People's "In your vault", Notes' links and the assistant never see it. Following a link into an item goes to Locker's wall. They are set and shown in one place, the item's **Linked to** section (add an account, a place or a person through a picker; tap one to unlink it).
- **Search finds a Locker item by its plain fields whether or not Locker is locked; opening the result goes behind the wall.** The Home tile counts items and shows none, and reads "Locked" or "Open".
- **The assistant works on Locker like the owner, except it never reveals or writes a sealed value.** Such a request ends in a decline. It may help with what a login is called and where it is filed, and has no business with the secret.
- **The phone is the unlock boundary.** Biometric with the passcode as fallback, relock when Centraid leaves the foreground, no separate Locker passphrase. Only the phone refusing the member counts as a failed unlock; a cancel does not. The wall says how many failed and when.
- **The key lives only in memory.** It derives from the 24 words, is zeroed on relock and is written nowhere. No gateway holds, mints or hands out a member key, and a "reveal" request is unrepresentable on that path rather than checked.
- **No history of reads, no recently-used shelf.** The only trace is each item's "Last used" stamp. A shelf of recent items would publish reading habits on the screen where reading is sensitive.
- **Never an invented all-clear.** Review shows what is known from metadata (flagged compromised, `http://` addresses, cards expired or expiring) and says what it did not check. Compromised is a flag the member sets.
- **Nothing leaves silently.** Export is plaintext to the OS save sheet only, after a confirm and a fresh owner check, receipted before any secret opens. A copied secret is cleared when the member locks. An open Locker is shielded from capture.
- **A secret saved mid-typing is a wrong secret.** Locker's editor saves on an explicit Save, and leaving with changes asks first. A password generator is unbiased and uses no look-alike characters.
- **The passkey slot is storage.** It is shown, renamed and removed; its key is never revealed, copied or exported.

## Identity and enrollment

- **One owner per vault, no roles, no password, no session.** A device is proved by its key. Enrollment is full trust: no companion tier or per-device attenuation.
- **The 24 words are the only recovery.** A fresh phone mints them in the core, shows them at once on a secure screen, and the shell has no word list or checksum. A restore takes the words or the seed, exactly one. A comparison number (safety number), never a hex id, is what the member verifies at pairing.
- **A member can read their words again on this phone,** and can keep a vault on its own words by opting in. Refusals never quote a word.
- **Keys cross the boundary borrowed and are written nowhere by the core.** The seed lives in the platform's secure store; absent seed is a state, not a fault.
