#!/usr/bin/env node
// Test-setup-only seeding for the Agenda v2 QA pass: a fresh dev vault has
// ZERO `schedule_calendar` rows and Agenda's own UI has no way to create one
// (CreateModal.jsx's "import an .ics file" hint is a dead end -- confirmed
// by source inspection: the ingest's eventPublisher never writes
// schedule_calendar either). That gap IS a bug and is reported separately;
// this script exists purely so the rest of the QA pass (propose/reschedule/
// rsvp/cancel) can be exercised at all, the same role seed.js plays for
// other blueprint apps that DO ship one. Agenda deliberately has no
// seed.js (per the QA brief), so this lives in the test rig instead of the
// app.
//
// MUST run with the Electron app fully closed (plain sqlite file access).
// Inserts:
//   - two schedule_calendar rows ("Personal" private, "Work" shared)
//   - one extra core_party ("Dana Kim") for attendee/RSVP testing
//   - two core_event + schedule_event_ext + schedule_attendee sets, both
//     tagged "[SEEDED]":
//       * "RSVP probe meeting" invites Dana (a non-owner) -- suite 3 drives
//         schedule.respond_rsvp against it via a direct window.centraid.write()
//         and also confirms the Guests section now renders her (needs-action)
//         through the real UI now that upcoming.js/search.js join
//         schedule_attendee (issue #337).
//       * "Your RSVP event" invites the OWNER, so the drawer's "You" row and
//         its Going/Maybe/Decline RSVP controls are reachable and clickable
//         end to end -- the crux of issue #337's point 4.
//
// Run with: node tests/e2e-live/seed-agenda-calendars.mjs <userDataDir>
import { DatabaseSync } from 'node:sqlite';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

function uuidv7ish() {
  // Not a real UUIDv7, just a unique enough id for test rows -- the schema
  // doesn't validate UUID version, only that it's TEXT.
  return crypto.randomUUID();
}

async function findVaultDb(userDataDir) {
  const vaultRoot = path.join(userDataDir, 'gateways', 'local', 'vault');
  const entries = await fs.readdir(vaultRoot, { withFileTypes: true });
  const vaultDir = entries.find((e) => e.isDirectory() && e.name !== 'keys');
  if (!vaultDir) throw new Error(`no vault directory found under ${vaultRoot}`);
  return path.join(vaultRoot, vaultDir.name, 'vault.db');
}

export async function seedAgendaCalendars(userDataDir) {
  const dbPath = await findVaultDb(userDataDir);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  try {
    const ownerRow = db.prepare('SELECT owner_party_id FROM core_vault LIMIT 1').get();
    if (!ownerRow) throw new Error('no core_vault row -- vault never bootstrapped?');
    const ownerPartyId = ownerRow.owner_party_id;

    const now = new Date().toISOString();

    // A fresh dev vault now bootstraps with a default "Personal" calendar, so
    // find-or-create by name to avoid a duplicate chip (an ambiguous
    // `.ag-cal-chip` selector) in the later suites. "Work" is still ours to add.
    const findOrCreateCalendar = (name, color, visibility) => {
      const existing = db
        .prepare('SELECT calendar_id FROM schedule_calendar WHERE name = ?')
        .get(name);
      if (existing) return existing.calendar_id;
      const id = uuidv7ish();
      db.prepare(
        `INSERT INTO schedule_calendar (calendar_id, owner_party_id, name, color, default_tz, visibility, external_uri)
         VALUES (?, ?, ?, ?, 'America/Los_Angeles', ?, NULL)`,
      ).run(id, ownerPartyId, name, color, visibility);
      return id;
    };
    const personalId = findOrCreateCalendar('Personal', '#4285f4', 'private');
    const workId = findOrCreateCalendar('Work', '#0b8043', 'shared');

    const danaId = uuidv7ish();
    db.prepare(
      `INSERT INTO core_party (party_id, kind, display_name, sort_name, birth_date, avatar_content_id, created_at, updated_at, ontology_version)
       VALUES (?, 'person', 'Dana Kim', 'Kim, Dana', NULL, NULL, ?, ?, 1)`,
    ).run(danaId, now, now);

    // One seeded event + attendee, purely to make schedule.respond_rsvp
    // reachable for a direct-invoke probe (see suite 3).
    const seededEventId = uuidv7ish();
    const seedStart = new Date(Date.now() + 3 * 86400000).toISOString();
    const seedEnd = new Date(Date.now() + 3 * 86400000 + 3600000).toISOString();
    db.prepare(
      `INSERT INTO core_event
         (event_id, ical_uid, summary, description, dtstart, dtend, start_tz, rrule, status,
          location_place_id, organizer_party_id, sequence, created_at, updated_at)
       VALUES (?, NULL, '[SEEDED] RSVP probe meeting', 'test-rig seeded row, not created via the Agenda UI', ?, ?, NULL, NULL, 'confirmed', NULL, ?, 0, ?, ?)`,
    ).run(seededEventId, seedStart, seedEnd, ownerPartyId, now, now);
    db.prepare(
      `INSERT INTO schedule_event_ext (event_ext_id, event_id, calendar_id, busy, conferencing_uri, reminders_json, travel_buffer_min)
       VALUES (?, ?, ?, 'busy', NULL, NULL, NULL)`,
    ).run(uuidv7ish(), seededEventId, personalId);
    const attendeeId = uuidv7ish();
    db.prepare(
      `INSERT INTO schedule_attendee (attendee_id, event_id, party_id, role, partstat, responded_at)
       VALUES (?, ?, ?, 'required', 'needs-action', NULL)`,
    ).run(attendeeId, seededEventId, danaId);

    // A second seeded event that invites the OWNER, so the drawer's "You" row
    // + RSVP controls (which only render for the is_you attendee) are
    // reachable through the real UI (issue #337 point 4). Kept a distinct
    // event from the Dana one so suite 3's "owner is NOT invited here"
    // negative probe against the first event stays valid.
    const seededOwnerEventId = uuidv7ish();
    const ownerStart = new Date(Date.now() + 4 * 86400000).toISOString();
    const ownerEnd = new Date(Date.now() + 4 * 86400000 + 3600000).toISOString();
    db.prepare(
      `INSERT INTO core_event
         (event_id, ical_uid, summary, description, dtstart, dtend, start_tz, rrule, status,
          location_place_id, organizer_party_id, sequence, created_at, updated_at)
       VALUES (?, NULL, '[SEEDED] Your RSVP event', 'test-rig seeded row; the owner is an invited attendee', ?, ?, NULL, NULL, 'confirmed', NULL, ?, 0, ?, ?)`,
    ).run(seededOwnerEventId, ownerStart, ownerEnd, danaId, now, now);
    db.prepare(
      `INSERT INTO schedule_event_ext (event_ext_id, event_id, calendar_id, busy, conferencing_uri, reminders_json, travel_buffer_min)
       VALUES (?, ?, ?, 'busy', NULL, NULL, NULL)`,
    ).run(uuidv7ish(), seededOwnerEventId, personalId);
    const ownerAttendeeId = uuidv7ish();
    db.prepare(
      `INSERT INTO schedule_attendee (attendee_id, event_id, party_id, role, partstat, responded_at)
       VALUES (?, ?, ?, 'required', 'needs-action', NULL)`,
    ).run(ownerAttendeeId, seededOwnerEventId, ownerPartyId);

    console.log(`[seed] vault: ${dbPath}`);
    console.log(`[seed] owner_party_id=${ownerPartyId}`);
    console.log(`[seed] calendars: Personal=${personalId} Work=${workId}`);
    console.log(`[seed] extra party: Dana Kim=${danaId}`);
    console.log(`[seed] seeded RSVP-probe event=${seededEventId} attendee=${attendeeId} (Dana)`);
    console.log(
      `[seed] seeded owner-RSVP event=${seededOwnerEventId} attendee=${ownerAttendeeId} (You)`,
    );
    const ids = {
      ownerPartyId,
      personalId,
      workId,
      danaId,
      seededEventId,
      attendeeId,
      seededOwnerEventId,
      ownerAttendeeId,
    };
    // Persist alongside the standard out/agenda-v2 screenshot dir so later
    // suites (3+) can read these ids back without re-deriving them.
    const idsPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'out',
      'agenda-v2',
      'seed-ids.json',
    );
    await fs.mkdir(path.dirname(idsPath), { recursive: true });
    await fs.writeFile(idsPath, JSON.stringify(ids, null, 2));
    return ids;
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const userDataDir = process.argv[2];
  if (!userDataDir) {
    console.error('usage: node seed-agenda-calendars.mjs <userDataDir>');
    process.exit(1);
  }
  const out = await seedAgendaCalendars(userDataDir);
  console.log(JSON.stringify(out, null, 2));
}
