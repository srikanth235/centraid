-- Read inside BEGIN IMMEDIATE. See `head_update.sql`.
SELECT head_object FROM vault WHERE vault_key = ?1;
