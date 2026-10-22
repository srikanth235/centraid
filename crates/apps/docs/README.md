# `centraid-apps-docs` — a drive as a projection of the vault

Docs is 4 queries and 18 actions. This crate is the read plane and the action table; the writes are `crates/vault`'s `document.*` commands and the shared verbs (`entity.*`, `flag.*`, `tag.*`, `container.*`), and the bytes ride a door.

| Module | What it is |
| --- | --- |
| `manifest` | The app's `manifest.json`, parsed by the kit's parser at load time. Two copies of "which tables does Docs write" is how the two answers drift. |
| `queries` | `drive`, `search`, `history` and `activity`: the statements, the folder rail, the labels, the size of each blob, the decoded body and the version walk. A screen is a window of `entity` rows and then one bounded read of each table that decorates the ids it returned. |
| `phone` | The phone's shelves (#1046): All and a folder cut from the one drive window, Starred, Recent and Trash cut from their own reads once the window is truncated ([`queries::ShelfArm`](src/queries.rs), Q-1047-7), the Type/Modified/label filters, the sort, the rail's counts, and the civil-time readings in the device's zone. Pure; no read of its own. |
| `kind` | What a document is to a member: its kind, which screen opens it (reader, stage, facts) and which Type pill it passes. Media type first, title second. |
| `bytes` | The three shell verbs as requests, plus the never-inline rule. No buffer, no filesystem, no socket. |
| `commands` | The eighteen actions as command invocations, `invoke_key` mandatory. An action names one command and takes that command's input verbatim; two actions may share one (`rename` and `rename-folder` are both `entity.retitle`). |

## The model Docs reads (#1135)

A document is an `entity` of kind `document` over a `document` row (the blob's hash, its media type, the folder it is filed in); a folder is an `entity` of kind `folder` over a `container` (its `parent_id` is the tree); a star or a label is a `tagged` edge; a past version is a `revision`; the words extracted from the bytes are the blob's `text` derivative. The vault's decisions are [R-1135-5-1 to R-1135-5-19](../../../docs/decisions.md#performance-and-scale).

## The rulings this crate is shaped by

Every one is an answer to a way this crate could be wrong.

**Identity is the document, never the bytes.** Two documents may legitimately share identical bytes (#352): a `document` row names a `blob`, and nothing in the drive is keyed by the blob. `document.blob` is not unique, where `photo.blob` is.

**The drive's window is by `created_at`** ([R-1135-5-14](../../../docs/decisions.md#docs)): the newest `limit` documents made, trashed ones included, so a star, a trash or a rename does not move a document in or out of it. A document attached to something and filed in no folder shows only where it is attached (a receipt on a transaction is not in the member's own cabinet); the exclusion runs after the window, so `truncated` is the vault's own cursor and `documents` may hold fewer rows than `window` while it is true. A document opens by id whatever it is attached to.

**The declared window is walked to its stated size (D-1020-DC10).** `MAX_PAGE_ROWS` clamps a page to 500, so asking for the 2,000-row window as one page would answer 500 and discard the cursor that says there are more. `entity.created_at` is `NOT NULL`, so the keyset walk is continuable and the window is walked to the size it names. `tests/year3.rs` states it at 8,000 documents.

**The bound reaches the size it names (D-1020-D3-12).** Every join is walked under a stated `FanOutBound`, and a walk that reaches it errors with that number (`ERROR_CODE_READ_BOUND_REACHED` through the core) rather than answering short.

**Bytes ride the door, never the payload (D-1020-DC4).** `blobText`, `blobUrl` and `stageBlob` are requests; the door is the seat's `centraid://` handler over a content-addressed store. The three executable media types (`text/html`, `application/xhtml+xml`, `image/svg+xml`) are refused at the request, before a door is asked: an uploaded document's bytes were authored by someone else, and served inline they are a stored XSS against the shell (#865). No type is not permission.

**A command claims its bytes** ([R-1135-5-9](../../../docs/decisions.md#the-vault-model)): `upload` is `document.add` over a blob the shell staged (`blob.stage {hash, size}`), `create-text` writes words through the byte store, `replace` puts down new bytes and keeps the old as a `revision`, and `edit` rewrites a text document in place. A followed folder sends records (`follow.files`), and a changed file is a replace.

**Activity is the journal** ([R-1135-5-11](../../../docs/decisions.md#docs)): the executed commands that named the document, newest first. The journal records the command and not who acted, so the row says what was done and the day.

**Nothing is shared and nothing arrives.** The share fold, the origin plane and the Shared shelf left with the sharing plane ([#1029's scope amendment](https://github.com/srikanth235/centraid/issues/1029#issuecomment-5755559795)).

## Trash

`entity.trash` stamps `purge_at` thirty days out and `entity.restore` brings a document back until then (it refuses once `purge_at` has passed, [R-1135-5-7](../../../docs/decisions.md#the-vault-model)). **"Delete forever" is `purge` → `entity.purge`, and "Empty trash" is `empty-trash` → `entity.empty_trash`**, which does the same to every trashed document (ruling D-1 of 2026-09-25 in [`docs/decisions.md`](../../../docs/decisions.md)). A purge collects the blobs nothing names any more in its own commit. No sweep runs on the phone, so a document whose window ran out and that nobody purged stays in Trash, unrestorable, until one of the two is chosen. A folder is a holder: trashing one takes the folders and documents under it, and a restore brings back exactly those ([R-1135-5-1](../../../docs/decisions.md#the-vault-model)).

## The phone's app query (#1046)

The phone asks `docs_drive`, `docs_search`, `docs_document` and `docs_activity` through `AppQueryRequest` (`crates/api-proto/proto/centraid/core/v1/docs.proto`), and `crates/core`'s `app_query::docs` runs these loaders over the page door. The shelf, the filters and the sort are the request's; `phone::shelve` cuts All and a folder from the one drive window, so **when the drive says `truncated`, those two shelves say so too** and only the three shelves the window does not define read for themselves.

## What stops this crate doing more

| Not allowed | What stops it |
| --- | --- |
| SQL, in any form | `cargo xtask rules`' `sql-confinement` scans this crate, tests included, and finds none. A volume's rows go through `centraid_apps_kit::fixtures`, where the kit keeps the app plane's one insert |
| The bytes themselves | `bytes` holds request shapes and the never-inline rule; the dependencies are the kit and `serde` |
| A write from a query | `queries` holds statements and a `PageDoor`, whose one method reads |
| An invocation with no `invoke_key` | the field is required (D-1020-D3-5) |
| A denial turned into an error | `Reading` and `Outcome::Denied` are states a surface renders; the kit's `KitError` has no denial variant |
| A widened scope | the manifest declares one `act` scope per distinct command an action names, so the consent a member grants is the commands Docs sends and no wider |

## Fixtures

- `tests/reads.rs` runs every query against a vault the product founds and Docs' own commands fill.
- `tests/year3.rs` is the `year3-docs` axis: 8,000 documents over 400 folders four levels deep, with a shrunken profile in the same shape that runs by default. Measured numbers and their provenance are in the receipt and `tests/journeys.json`.
