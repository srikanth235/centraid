-- Redemption is a conditional UPDATE, not a read-then-write: two phones racing
-- on one invite must end with one vault, and `redeemed_at_ms IS NULL` in the
-- predicate is what makes the second one affect zero rows.
UPDATE invite
SET redeemed_at_ms = ?2, redeemed_by = ?3
WHERE code_hash = ?1 AND redeemed_at_ms IS NULL;
