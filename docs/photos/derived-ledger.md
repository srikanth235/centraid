# Photos derived data

What the vault holds for data derived from a member's photographs, and what in it is still live. **Nothing runs a model over a member's bytes.** The recognition plane, its embeddings, its face rows and the memories projection were deleted ([#1029](https://github.com/srikanth235/centraid/issues/1029), [R-1135-5-18](../decisions.md#photos)); what computes is the renditions and the perceptual hash a photograph may carry.

## Derived rows are `derivative` rows

A derivative is a row keyed `(blob, variant)`: the variant is `thumb`, `preview`, `poster`, `text`, `caption`, `phash` or `thumbhash`. An image variant (`thumb`, `preview`, `poster`) names the blob it was drawn into (`out`) and its media type; a text variant (`text`, `caption`, `phash`, `thumbhash`) carries its words. The DDL is [`contracts/schema/vault-ddl.sql`](../../contracts/schema/vault-ddl.sql). A derivative belongs to the bytes, not to a photograph: two photographs cannot share a blob (`photo.blob` is unique), and a derivative goes with its blob when nothing names the blob any more.

A derivative **enriches and never gates.** A missing thumbnail does not hide a photograph: the grid's `held_thumbnail` falls back `thumb` → `poster` → the original's own hash.

## Renditions come from the command that adds the photograph

The `thumb` and `preview` renditions are made by [`crates/media/src/renditions.rs`](../../crates/media/src/renditions.rs). A shell that drew its own stages them with `derivative.write`; when it did not, `photo.add` derives them from the bytes it holds ([R-1135-5-10](../decisions.md#the-vault-model)). A file that does not decode produces no rendition and the grid falls back to the original. The contract (sizes, orientation, metadata stripping, the deferred video poster and HEIC decode) is in [Photos](README.md#the-phone-viewers-layout).

## Duplicates are not read

Photos has no Duplicates screen and nothing clusters the perceptual hashes ([#1146](https://github.com/srikanth235/centraid/issues/1146) D5, retiring [R-1135-5-15](../decisions.md#photos)): `crates/media`'s clustering, the `photos.duplicates` query and the two screens are gone, and their wire numbers are reserved. A `phash` derivative is still accepted by `photo.add` and kept, but no read uses it.

## Memories and faces are gone

Nothing wrote the memories projection or a face region after #1029, so the Memories and People/Face-review surfaces were deleted with their queries, core arms, proto messages and native views ([R-1135-5-18](../decisions.md#photos); [Q-1047-2](../decisions.md#photos)). The vault holds no table for either. A shell that draws "who is in it" or "on this day" again starts from a producer, not from these screens.

## Related

- [`contracts/schema/vault-ddl.sql`](../../contracts/schema/vault-ddl.sql) — `derivative`, `blob`, `photo`.
- [`crates/media`](../../crates/media/README.md) — renditions, phash.
