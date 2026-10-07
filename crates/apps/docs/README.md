# `centraid-apps-docs` — a drive as a projection of the vault

Docs is 5 queries, 18 actions and 29 scopes over three schemas, plus a demo seed. This crate is the read plane and the action table; the writes are `crates/vault`'s `core` schema — **all eighteen of them** — and the bytes ride a door.

| Module | What it is |
| --- | --- |
| `manifest` | The app's `manifest.json`, parsed by the kit's parser at load time. Two copies of "which tables does Docs write" is how the two answers drift. |
| `queries` | `drive`, `search`, `document`, `history` and `activity`: the statements, the taxonomy pair, the folder rail, the labels, the custody decoration, the decoded body and the occurrence walk. |
| `phone` | The phone's shelves (#1046): All, a folder, Starred, Recent and Trash cut from the one drive window, v0's Type/Modified/label filters, the sort, the rail's counts, and the civil-time readings in the device's zone. Pure; no read of its own. |
| `kind` | What a document is to a member — its kind, which screen opens it (reader, stage, facts) and which Type pill it passes — media type first, title second. |
| `bytes` | The three shell verbs as requests, plus the never-inline rule. No buffer, no filesystem, no socket. |
| `commands` | The eighteen actions as `core.*` invocations, `invoke_key` mandatory. |

## The rulings this crate is shaped by

Every one is an answer to a way this crate could be wrong, and every one has a test named after it.

**D-1020-DC1 — identity is the wrapper, never the bytes.** A document is a `core.document` wrapper around a sha256-deduped content item, and **two documents may legitimately share identical bytes** (#352). Dedup is on the bytes; a reader that keyed a drive row by content id would merge two members' unrelated files. `n_wrappers_over_one_sha_are_n_drive_rows` is a property test over _n_, not a case at two, because code that special-cased two would still be wrong at three — and each of the _n_ carries its own history and its own representation over the same sha.

**Nothing is shared and nothing arrives.** The share fold, the origin plane, `shared_with`, `shared_from` and the Shared shelf left with the sharing plane ([#1029's scope amendment](https://github.com/srikanth235/centraid/issues/1029#issuecomment-5755559795)); the manifest declares no `share`, `social` or `core.party` read.

**D-1020-D3-12 — the bound reaches the size it names.** Every join here is walked under a stated `FanOutBound` (`DOC_JOIN_BOUND`, `DOC_PAIR_BOUND`), and a walk that reaches it errors with that number — `ERROR_CODE_READ_BOUND_REACHED` through the core — rather than answering short.

**D-1020-DC4 — bytes ride the door, never the payload.** `blobText`, `blobUrl` and `stageBlob` are requests; the door is the seat's `centraid://` handler over a content-addressed store. The three executable media types (`text/html`, `application/xhtml+xml`, `image/svg+xml`) are refused **at the request**, before a door is asked: an uploaded document's bytes were authored by someone else, and served inline they are a stored XSS against the shell (#865). **No type is not permission** — a document whose representation this vault cannot read is offered as a download, never embedded.

**D-1020-DC8 — the staged path is real; the inline binary path is a receipted refusal.** Claiming a staged sha is pure row work, so a scanned PDF files, versions and restores for real. An inline `data:` payload that is not `text/*` needs a spill into the local content store, and `CommandCtx` carries no blob door — so it refuses with a sentence naming the way through, as a **precondition** with its own predicate rather than a throw. Bytes this vault already holds are exempt, because the mint dedupes before it would spill.

## The four queries, and the three reads that discover rows

**D-1020-DC10 — the declared window is walked to its stated size.** `MAX_PAGE_ROWS` clamps a page to 500, so asking for the 2,000-row window as one page would answer 500 documents and discard the cursor that says there are more — **500 of 7,600 live documents** at the year-3 profile. A list is where a clamp is defensible, but the clamp has to be the one the caller asked for and not one the page contract imposed behind it; `core_tag.tagged_at` is `NOT NULL`, so the keyset walk is continuable and the stated window is reachable. Photos' library takes one page instead, because its own sort column is nullable and a walk there would silently drop every NULL (D-1020-P11). The walk answers 2,000 in 480 ms at that profile, and `truncated` is still the read's own claim rather than a row count.

The drive's window is a **walked page set** over `core_tag`, newest `tagged_at` first. Everything else — the wrappers, the stars, the labels, the content rows, the custody states and the representations — is `IN`-bounded by ids that page returned. `truncated` is that page's own cursor: `rows.length >= window` cannot tell a window that filled exactly from one that ran out.

The second discovery read is `search`'s FTS read, which belongs to `crates/search`; the hits arrive here in **rank order** and the fold keeps it.

`history` walks occurrences from `current_revision_id` through `parent_revision_id`, capped at `MAX_CHAIN_STEPS` (500). A→B→A→B is **four** versions, and the date shown is the occurrence's own — restoring an old version reads as the newest entry even though its bytes are old.

`document` is one row found by id rather than through the window — so a document beyond the window, or one search found, opens exactly as a browsed one does — plus its folder path and its **decoded body**: `core_content_text.body_text` for the head's content. An absent row is "no text for these bytes" (binary, or text that would not decode) and a row holding `""` is an empty text document; the two are `None` and `Some("")`, never folded together.

`activity` reads `access_provenance` scoped by the polymorphic `(entity_type, entity_id)` pair. An empty rail is honest: no activity has been recorded yet, not an error.

**The frozen fixture records a refusal here.** The implementation it was captured from served only tables registered as entities through its paged door, and `access_provenance` declares no `FOREIGN KEY (prov_id) REFERENCES core_entity(entity_id)` — so `docs.activity.provenance` was refused for every caller, the owner included. `crates/apps/docs/tests/parity.rs`'s `the_activity_rail_the_gateways_door_refuses` reads the three events a filed-then-edited-then-starred document actually has, beside that recorded refusal.

## The phone's app query (#1046)

The phone asks `docs_drive`, `docs_search`, `docs_document` and `docs_activity` through `AppQueryRequest` (`crates/api-proto/proto/centraid/core/v1/docs.proto`), and `crates/core`'s `app_query::docs` runs these loaders over the page door. The shelf, the filters and the sort are the request's; `phone::shelve` cuts them from the one drive window, so **when the drive says `truncated`, every shelf and count is of the newest `limit` filed documents only** — v0's own limitation, carried and stated. Search is not windowed. The core adds the two facts only it can: the size phrase (`format_byte_size`, the formatter Home's tile reads) and whether the head's bytes are on this device (`Vault::content_location`).

## Trash

`core.trash_document` stamps `purge_at` thirty days out and `core.restore_document` brings a document back until then (it refuses once `purge_at <= now`). **"Delete forever" is `purge` → `core.purge_document`, and "Empty trash" is `empty-trash` → `core.empty_document_trash`, which does the same to every trashed document** — ruling D-1 of 2026-09-25 in [`docs/decisions.md`](../../../docs/decisions.md), which supersedes 2026-09-10's "the gateway's lifecycle sweep is the only destroyer" (that sweep left with the gateway, #1029). Both are confirm-gated in the manifest and destroy through the path Photos' `media.purge_asset` takes: the wrapper goes through the entity supertype, so its folder tag, star, labels, representation, links and collection entries cascade; its version occurrences go leaf-first (an occurrence is immutable, #916 R3); and every content item it ever named is released through `release_content_now` when nothing else rents it. No sweep runs on the phone, so a document whose window lapsed and that nobody purged stays in Trash, unrestorable, until one of the two destroys.

## Adding a document on the phone

A picked or scanned file is staged through the core's stage frames (`Request::Stage` begin/chunk/end, the Photos import's door) and filed by `upload` → `core.add_document` with the handle's `content_hash` as `staged_sha`, a title and an optional `folder_id`. The Add sheet's "Text" is `create-text` → `core.create_text_document` (`title`, optional `folder_id`, `media_type` `text/plain` or `text/markdown`, optional `body_text`): the core turns the words into the bytes, so a shell never spells a `data:` URI. A scan is an OS camera flow that produces a file, so it takes the upload path.

## What stops this crate doing more

| Not allowed | What stops it |
| --- | --- |
| SQL, in any form | `cargo xtask rules`' `sql-confinement` scans this crate — tests included — and finds none. The door suite's fixture rows go through `centraid_apps_kit::fixtures`, where the kit already keeps the app plane's one insert |
| The bytes themselves | `bytes` holds request shapes and the never-inline rule; the dependencies are the kit and `serde` |
| A write from a query | `queries` holds statements and a `PageDoor`, whose one method reads |
| An invocation with no `invoke_key` | the field is required (D-1020-D3-5) |
| A denial turned into an error | `Reading` and `Outcome::Denied` are states a surface renders; the kit's `KitError` has no denial variant |
| A widened scope | the manifest declares **eighteen `act` scopes, one per action**, and `it_declares_twenty_nine_scopes_with_one_act_scope_per_action` compares them against the action table. One `read+act` over `core` would hand Docs `core.merge_party` |
