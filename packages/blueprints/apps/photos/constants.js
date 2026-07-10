// Built-in shelves share the album strip without being albums. The prefix
// can never collide with a vault id — ids are opaque tokens, not colons.
// Shared by app.jsx (which owns `selectedAlbum`) and Chips.jsx (which needs
// the same literal values to mark the Favorites/Trash chip active).
export const FAVORITES = 'built-in:favorites';
export const TRASH = 'built-in:trash';
