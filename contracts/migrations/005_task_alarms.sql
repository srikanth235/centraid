-- A reminder may carry several time alerts. The primary lead remains the
-- single-alert editor's compatibility field; imports retain the whole list.
ALTER TABLE task ADD COLUMN reminders TEXT CHECK (reminders IS NULL OR json_valid(reminders));
