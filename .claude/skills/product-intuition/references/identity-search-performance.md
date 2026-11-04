# Identity, search, and performance

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

- **Declare year-3 volume and measure at it.** A feature is fast on an empty vault by accident. Reads page by keyset, never offset; bounds must be exercised by their scale profile or they are unproven. Search is bounded by construction at year-3 scale (title matches, then the newest 500 others) and its plans are checked, not its seconds.
- **A performance design is adopted only on evidence** from the journey ledger at the owner's volume on the owner's hardware. An emulator number never becomes a ceiling.
- **A cap never names a size it cannot reach,** and a page never silently drops rows (undated photographs, nullable sort keys). If it cannot fit in a commit, it is owed and done when idle.
