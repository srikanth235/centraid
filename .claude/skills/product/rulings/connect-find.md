# Connect and find

Links, attachments and search. Every item can be linked to any other kind but a Locker item, through one picker (see [promises](../promises.md)).

## Search

- **One index, found the way a person types.** Every typed or labelling text column is findable. A trashed entity leaves the index, and its earlier versions with it. Fuzzy matching corrects to a whole word the vault holds, never an invented one, and says "Including results for “…”" when it did. A line from 2019 is as findable as one from this month.
- **What an item said before is found, as the item.** The words of earlier versions are indexed for every kind with an Earlier versions page (note, event, task, person, document, photo, transaction, workout); note history has no exemption. The result is the live item, once. When the words match only an earlier version the row says "In an earlier version" and opens that item's Earlier versions; when they match what it says now, or both, the row is the ordinary one. The same line and the same page in Home's search and in every app's search (Photos' search shows such a photograph as a row under the grid, with the line). A purge removes an item's earlier words from the index in the same transaction, a trashed item's leave with it, and a value is indexed where it first appears, so an item edited a hundred times does not carry a hundred copies. A kind with no Earlier versions page (a notebook, folder, album, project, chat thread) is found by what it is called now. A link sheet (Notes' `[[` picker) offers what things are called now.
- **Search never reads a secret.** Locker's sealed cells, passkey keys and the assistant's own words are never indexed, and a Locker item's earlier versions (its history is sealed) are not searched. A chat is found by its title and the member's words only.
- **Search is the vault's, not the phone's.** No client substring matching, no per-app engine. Closing search clears the term and the answer.

## Links

- **A link to a person is set by hand, in the screen that owns the thing, with one picker.** A payment's **With** row, a photo's **People in this photo**, a document's **About** and a Locker item's **Linked to** (an account, a place or a person) all pick by name from the same sheet, and a tap on one already linked takes it off. Money alone proposes: it offers the person a payee names ("With Priya?", Confirm or Not them), writes nothing until Confirm, and a "Not them" lasts until the page is opened again. A Locker link is seen only inside Locker.
