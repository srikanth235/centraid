# `centraid-search` — the FTS door

Text search is a question the **vault** answers, not one an app answers by pulling a table. The vault keeps one index, `search`: a contentless FTS5 table whose rowid is `entity.n`, written at commit by the vault's gate for every entity a command touched ([#1135](https://github.com/srikanth235/centraid/issues/1135), [docs/vault-ontology.md](../../docs/vault-ontology.md)). This crate owns every `MATCH` statement in the workspace; the app kit's grammar has no `MATCH` production, so "an app cannot search by hand" is a fact rather than a convention. Ruling **D-1020-N1** ([#1020](https://github.com/srikanth235/centraid/issues/1020)).

```rust
let door = SqliteDoor::open(&connection)?;   // checks `search` and `search_vocab` exist
let answer = door.query(&Principal::Owner, &SearchRequest::new("note", "cabin", 8))?;
match answer {
    Answer::Denied(denial) => /* a surface renders the ask */,
    Answer::Data { page, window } => /* page.rows: Vec<Target>, page.next: keyset */,
}
```

- **A request names a kind** (`SearchRequest::new("note", ...)`) or several (`across`), and may exclude ids. A kind that is not searchable (Locker is not an entity at all; a tag has no text) is a typed `SearchError::NotSearchable`, never an empty page: an empty page would claim there were no matches.
- **Every read is a window.** `limit` is required and has no default; it is clamped by `MAX_MATCH_ROWS` and `Answer::window` reports the size it actually reached.
- **A window continues by keyset** over `(rank, id)`. FTS5's `rank` is bm25 negated, so ascending is best-first; title weighs over body, carried by the query.
- **A denial is a value.** `Answer::Denied` is a state a surface renders; an `Err` is for a question that cannot be answered at all.
- **A result is an entity's id, kind and title and a snippet** read from `entity` joined on `n`, with the trash filter. It carries no `Value`, no map and no byte field, and the index holds no secret, so a result cannot carry one. Locker is not in the index.
- **The snippet is cut in Rust.** The index is contentless and cannot say which words matched, so `snippet_of` runs the vault's own `text_of` over the row and excerpts around the first matching token.
- **Correction is a bounded lookup** over the one `search_vocab` (`MAX_VOCAB_SCAN` rows per word): a misspelt word is replaced by a whole term the index holds.

It is not the consent pipeline: it answers the owner's view of the vault it is handed. A stub that looked like a consent check would be worse than an absence written down here.

`tests/door.rs` drives it against a founded vault: ranking, the trash filter, keyset continuation, correction, the snippet, and every refusal.
