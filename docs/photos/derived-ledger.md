# Photos derived data

What the vault holds for data derived from a member's photographs, and what in it is still live. **Nothing runs a model over a member's bytes.** The recognition plane, its embeddings, its face rows and the memories projection were deleted ([#1029](https://github.com/srikanth235/centraid/issues/1029), [R-1135-5-18](../decisions.md#lane-5--docs-and-photos-1135)); what computes is the renditions, the perceptual hash, and the duplicates read.

## Derived rows are `derivative` rows

A derivative is a row keyed `(blob, variant)`: the variant is `thumb`, `preview`, `poster`, `text`, `caption`, `phash` or `thumbhash`. An image variant (`thumb`, `preview`, `poster`) names the blob it was drawn into (`out`) and its media type; a text variant (`text`, `caption`, `phash`, `thumbhash`) carries its words. The DDL is [`contracts/schema/vault-ddl.sql`](../../contracts/schema/vault-ddl.sql). A derivative belongs to the bytes, not to a photograph: two photographs cannot share a blob (`photo.blob` is unique), and a derivative goes with its blob when nothing names the blob any more.

A derivative **enriches and never gates.** A missing thumbnail does not hide a photograph: the grid's `held_thumbnail` falls back `thumb` → `poster` → the original's own hash, and a photograph with no `phash` is simply not in a duplicate cluster.

## Renditions come from the command that adds the photograph

The `thumb` and `preview` renditions are made by [`crates/media/src/renditions.rs`](../../crates/media/src/renditions.rs). A shell that drew its own stages them with `derivative.write`; when it did not, `photo.add` derives them from the bytes it holds ([R-1135-5-10](../decisions.md#lane-5--docs-and-photos-1135)). A file that does not decode produces no rendition and the grid falls back to the original. The contract (sizes, orientation, metadata stripping, the deferred video poster and HEIC decode) is in [Photos](README.md#the-phone-viewers-layout).

## Duplicates are clustered when asked

A photograph's perceptual hash is its `phash` derivative. [`crates/media/src/duplicates.rs`](../../crates/media/src/duplicates.rs) is the one clustering, a pure fold: union-find over a Hamming distance of six or fewer, the group's lowest photograph id as its key. The core runs it when `photos.duplicates` is asked for (the app query, [R-1135-5-15](../decisions.md#lane-5--docs-and-photos-1135)) over the live photographs' hashes, so a trashed photograph or a new hash is in the next answer and nothing is stored to go stale. The read takes the first 4,000 fingerprints by blob, which a 90,000-photograph library exceeds; [`crates/apps/photos/tests/year3.rs`](../../crates/apps/photos/tests/year3.rs) states both volumes.

## Memories and faces are gone

Nothing wrote the memories projection or a face region after #1029, so the Memories and People/Face-review surfaces were deleted with their queries, core arms, proto messages and native views ([R-1135-5-18](../decisions.md#lane-5--docs-and-photos-1135); [Q-1047-2](../decisions.md#open-questions-for-the-owner-1046-1047)). The vault holds no table for either. A shell that draws "who is in it" or "on this day" again starts from a producer, not from these screens.

## Related

- [`contracts/schema/vault-ddl.sql`](../../contracts/schema/vault-ddl.sql) — `derivative`, `blob`, `photo`.
- [`crates/media`](../../crates/media/README.md) — renditions, phash, duplicates.
