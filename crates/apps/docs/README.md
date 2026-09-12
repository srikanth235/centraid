# `centraid-apps-docs` — a drive as a projection of the vault

Docs is 13,183 lines of v0 TypeScript: 4 queries, 16 actions, 34 scopes over five schemas, and an 82-line demo seed. This crate is the read plane and the action table; the writes are `crates/vault`'s `core` schema — **all sixteen of them** — and the bytes ride a door.

| Module | What it is |
| --- | --- |
| `manifest` | v0's `app.json`, byte for byte, parsed by the kit's parser at load time. Two copies of "which tables does Docs write" is how the two answers drift. |
| `queries` | `drive`, `search`, `history` and `activity`: the statements, the taxonomy pair, the folder rail, the labels, the custody decoration and the occurrence walk. |
| `shares` | The share fold — who a document is shared with, over the document **or any folder above it**, with nine bounded windows under one stated cap. |
| `origins` | Where a document came from. A second, independent denial over an independent plane: a delivered copy carries no folders-scheme tag, so the drive's window cannot see it. |
| `bytes` | The three shell verbs as requests, plus the never-inline rule. No buffer, no filesystem, no socket. |
| `commands` | The sixteen actions as `core.*` invocations, `invoke_key` mandatory. |

## The rulings this crate is shaped by

Every one is an answer to a way the port could have been wrong, and every one has a test named after it.

**D-1020-DC1 — identity is the wrapper, never the bytes.** A document is a `core.document` wrapper around a sha256-deduped content item, and **two documents may legitimately share identical bytes** (#352). Dedup is on the bytes; a port that keyed a drive row by content id merges two members' unrelated files. `n_wrappers_over_one_sha_are_n_drive_rows` is a property test over *n*, not a case at two, because a port that special-cased two would still be wrong at three — and each of the *n* carries its own history and its own representation over the same sha.

**D-1020-DC2 — the fold is one module with named windows.** A share is a **standing answer, not a roster**: `share_authority` holds who may reach the document and `share_fulfillment` holds whether it has reached them. `via` says `document` or `folder`, so a member is never told the document itself was shared when it only sits in a shared folder. `delivered_at IS NOT NULL` is the only thing that makes a member `current` (#846: a pass that went unreachable drops back to `syncing`, and reading that as "invited" would tell someone a share they watched land had never arrived). **A denial is `Denied`, not `[]`** — "we cannot see" and "shared with nobody" are different facts and the second is the one a member acts on.

**D-1020-D3-12 — the bound reaches the size it names.** `SHARE_FAN_OUT` is `{500, 8}` and its page size is exactly `MAX_PAGE_ROWS`, so it walks the 4,000 rows it states and errors at the 4,001st with that number. `the_share_fan_out_reaches_four_thousand_and_errors_at_the_next_row` seeds both sides of the boundary against a real vault. A raised page size would silently halve it, which is the arithmetic Tally's `LEDGER_FAN_OUT` gets wrong.

**D-1020-DC4 — bytes ride the door, never the payload.** `blobText`, `blobUrl` and `stageBlob` are requests; the door is the seat's `centraid://` handler over a content-addressed store. The three executable media types (`text/html`, `application/xhtml+xml`, `image/svg+xml`) are refused **at the request**, before a door is asked: a shared document's bytes are authored by someone else, and served inline they are a stored XSS against the shell (#865). **No type is not permission** — a document whose representation this vault cannot read is offered as a download, never embedded.

**D-1020-DC8 — the staged path is real; the inline binary path is a receipted refusal.** Claiming a staged sha is pure row work, so a scanned PDF files, versions and restores for real. An inline `data:` payload that is not `text/*` needs a spill into the local content store, and `CommandCtx` carries no blob door — so it refuses with a sentence naming the way through, as a **precondition** with its own predicate rather than a throw. Bytes this vault already holds are exempt, because the mint dedupes before it would spill.

## The four queries, and the three reads that discover rows

The drive's window is a **page** of `core_tag`, newest `tagged_at` first. Everything else — the wrappers, the stars, the labels, the content rows, the custody states, the representations and the whole share fold — is `IN`-bounded by ids that page returned. `truncated` is that page's own cursor: `rows.length >= window` cannot tell a window that filled exactly from one that ran out.

The second discovery read is the origin plane, and it runs **before** the folders-scheme gate — because the scheme is created on first use, and returning early there told a member who had *received* a document that nothing had arrived. The third is `search`'s FTS read, which belongs to `crates/search`; the hits arrive here in **rank order** and the fold keeps it.

`history` walks occurrences from `current_revision_id` through `parent_revision_id`, capped at `MAX_CHAIN_STEPS` (500). A→B→A→B is **four** versions, and the date shown is the occurrence's own — restoring an old version reads as the newest entry even though its bytes are old.

`activity` reads `access_provenance` scoped by the polymorphic `(entity_type, entity_id)` pair. An empty rail is honest: no activity has been recorded yet, not an error.

## What stops this crate doing more

| Not allowed | What stops it |
| --- | --- |
| SQL, in any form | `cargo xtask rules`' `sql-confinement` scans this crate — tests included — and finds none. The door suite's fixture rows go through `centraid_apps_kit::fixtures`, where the kit already keeps the app plane's one insert |
| The bytes themselves | `bytes` holds request shapes and the never-inline rule; the dependencies are the kit and `serde` |
| A write from a query | `queries` holds statements and a `PageDoor`, whose one method reads |
| An invocation with no `invoke_key` | the field is required (D-1020-D3-5) |
| A denial turned into an error | `Reading` and `Outcome::Denied` are states a surface renders; the kit's `KitError` has no denial variant |
| A widened scope | the manifest declares **sixteen `act` scopes, one per action**, and `it_declares_thirty_four_scopes_with_one_act_scope_per_action` compares them against the action table. One `read+act` over `core` would hand Docs `core.merge_party` |
