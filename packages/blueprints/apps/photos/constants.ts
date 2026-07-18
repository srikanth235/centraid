// Built-in shelves share the album strip without being albums. The prefix
// can never collide with a vault id — ids are opaque tokens, not colons.
// Shared by app.tsx (which owns `selectedAlbum`) and the sidebar (which needs
// the same literal values to mark the Favorites/Trash chip active).
export const FAVORITES = 'built-in:favorites';
export const TRASH = 'built-in:trash';
// The duplicates shelf (issue #352 / #299): a chip like Favorites/Trash, but
// its "assets" aren't album membership — selecting it swaps the grid for
// DuplicatesView, which owns its own async load (see duplicates.ts).
export const DUPLICATES = 'built-in:duplicates';
// The v2 "Albums" overview (a grid of album cover cards) — same one-slot
// trick as the other built-ins above. Its "assets" are empty (AlbumGrid.tsx
// reads `albums` directly, not `albumAssets()`), same as DUPLICATES.
export const ALBUMS = 'built-in:albums';
