-- Every table in the state file, for the canary's dump. The names come from
-- SQLite itself and never from a request, which is what makes the templated
-- read beside this one safe.
SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name;
