# `centraid-search` — the FTS door

Text search is a question the **vault** answers, not one an app answers by pulling a table. The vault keeps one index, `search`: a contentless FTS5 table whose rowid is `entity.n`, written at commit by the vault's gate for every entity a command touched ([#1135](https://github.com/srikanth235/centraid/issues/1135), [docs/vault-ontology.md](../../docs/vault-ontology.md)). This crate owns every `MATCH` statement in the workspace; the app kit's grammar has no `MATCH` production, so "an app cannot search by hand" is a fact rather than a convention. Ruling **D-1020-N1** ([#1020](https://github.com/srikanth235/centraid/issues/1020)).

```rust
let door = SqliteDoor::open(&connection, vault.words())?;   // checks `search` and `search_vocab` exist; the vault keeps the word list
let answer = door.query(&Principal::Owner, &SearchRequest::new("note", "cabin", 8))?;
match answer {
    Answer::Denied(denial) => /* a surface renders the ask */,
    Answer::Data { page, window } => /* page.rows: Vec<Target>, page.next: keyset */,
}
```

- **A request names a kind** (`SearchRequest::new("note", ...)`) or several (`across`), and may exclude ids. A kind that is not searchable (a tag has no text; a flag, a calendar, an account are labels of what they label) is a typed `SearchError::NotSearchable`, never an empty page: an empty page would claim there were no matches. `locker_item` is searchable by its plain text and nothing sealed, by every caller including the assistant (the owner's ruling of 2026-10-22): there is no principal that is refused it.
- **Every read is a window.** `limit` is required and has no default; it is clamped by `MAX_MATCH_ROWS` and `Answer::window` reports the size it actually reached.
- **A window continues by keyset** over `(tier, rank, id)`. Tier 0 is the entities whose title holds every word (uncapped), tier 1 the newest `TAIL_ROWS` other matches by rowid, the kind, trash and excluded-id filters applied before the count. FTS5's `rank` is bm25 negated, so ascending is best-first; title weighs over body, carried by the query. A test holds the plan: the tail leg streams the index in rowid order and is never sorted whole.
- **One letter is not a search.** A query whose words are all one character is `SearchError::NoSearchableWords`, the same answer as the empty query, which every surface already draws as its empty-term view.
- **Several kinds, one statement.** `Search::query_each` answers at most N rows of each kind by `row_number() OVER (PARTITION BY kind ...)`; Home uses it.
- **A denial is a value.** `Answer::Denied` is a state a surface renders; an `Err` is for a question that cannot be answered at all.
- **A result is an entity's id, kind and title and a snippet** read from `entity` joined on `n`, with the trash filter. It carries no `Value`, no map and no byte field, and the index holds no secret, so a result cannot carry one: a Locker item is in it by its plain text (`password`, `otp_seed`, `card_number`, `cvv`, `content`, `locker_item_field.value_sealed` and `locker_item_passkey.private_key` are never text), whether or not Locker is locked.
- **The snippet is cut in Rust.** The index is contentless and cannot say which words matched, so `snippet_of` runs the vault's own `text_of` over the row and excerpts around the first matching token.
- **Correction is a lookup in the word list.** The vault keeps its words in memory (`Vault::words()`, checked against the table on every use); a misspelt word is replaced by ONE whole word of it: one edit anywhere, else a first-letter change, else the fragment inside a longer word, ranked by the documents that hold each (`SELECT doc FROM search_vocab WHERE term = ?`). A word some word starts with is kept.The list is one list for every reader.

It is not the consent pipeline: it answers the owner's view of the vault it is handed. A stub that looked like a consent check would be worse than an absence written down here.

`tests/door.rs` drives it against a founded vault: ranking, the trash filter, keyset continuation, correction, the snippet, and every refusal.
