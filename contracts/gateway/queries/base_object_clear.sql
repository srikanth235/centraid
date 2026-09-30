-- A base's membership is replaced wholesale, never merged: a re-put with a
-- shorter object list must not leave the dropped members behind.
DELETE FROM base_object WHERE vault_key = ?1 AND base_id = ?2;
