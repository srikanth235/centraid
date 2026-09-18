-- Mark a token spent. Conditional on it not being spent already, which is what
-- makes a replayed receipt visible rather than silently re-granting a plan.
UPDATE purchase_token SET redeemed_at_ms = ?2
WHERE token = ?1 AND redeemed_at_ms IS NULL;
