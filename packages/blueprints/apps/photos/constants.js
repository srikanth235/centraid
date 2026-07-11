// Built-in shelves share the album strip without being albums. The prefix
// can never collide with a vault id — ids are opaque tokens, not colons.
// Shared by app.jsx (which owns `selectedAlbum`) and Chips.jsx (which needs
// the same literal values to mark the Favorites/Trash chip active).
export const FAVORITES = 'built-in:favorites';
export const TRASH = 'built-in:trash';
// The duplicates shelf (issue #352 / #299): a chip like Favorites/Trash, but
// its "assets" aren't album membership — selecting it swaps the grid for
// DuplicatesView, which owns its own async load (see duplicates.js).
export const DUPLICATES = 'built-in:duplicates';
