-- Additive Agenda metadata; existing reminders and calendars retain their values.
ALTER TABLE task ADD COLUMN url TEXT;
ALTER TABLE event ADD COLUMN travel_minutes INTEGER NOT NULL DEFAULT 0 CHECK (travel_minutes >= 0 AND travel_minutes <= 10080);
ALTER TABLE container ADD COLUMN icon_key TEXT;
