-- THE CANARY'S WIDEST WINDOW. `{table}` is substituted by the adapter with a
-- name read from `tables_select.sql` — SQLite's own catalogue, never anything
-- a client sent — because SQL has no parameter form for an identifier. It is
-- the one templated statement in this directory and it is read-only.
SELECT * FROM "{table}";
