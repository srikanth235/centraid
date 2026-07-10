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
//   - one core_event + schedule_event_ext + schedule_attendee row, tagged
//     "[SEEDED]", solely so suite 3 can drive schedule.respond_rsvp via a
//     direct window.centraid.write() call and observe a REAL executed
//     outcome (the Agenda UI itself can never reach this: upcoming.js/
//     search.js never join schedule_attendee, so Guests never render --
//     see EventDrawer.jsx's own header comment admitting this).
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

    const personalId = uuidv7ish();
    const workId = uuidv7ish();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO schedule_calendar (calendar_id, owner_party_id, name, color, default_tz, visibility, external_uri)
       VALUES (?, ?, 'Personal', '#4285f4', 'America/Los_Angeles', 'private', NULL)`,
    ).run(personalId, ownerPartyId);
    db.prepare(
      `INSERT INTO schedule_calendar (calendar_id, owner_party_id, name, color, default_tz, visibility, external_uri)
       VALUES (?, ?, 'Work', '#0b8043', 'America/Los_Angeles', 'shared', NULL)`,
    ).run(workId, ownerPartyId);

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

    console.log(`[seed] vault: ${dbPath}`);
    console.log(`[seed] owner_party_id=${ownerPartyId}`);
    console.log(`[seed] calendars: Personal=${personalId} Work=${workId}`);
    console.log(`[seed] extra party: Dana Kim=${danaId}`);
    console.log(`[seed] seeded RSVP-probe event=${seededEventId} attendee=${attendeeId}`);
    const ids = { ownerPartyId, personalId, workId, danaId, seededEventId, attendeeId };
    // Persist alongside the standard out/agenda-v2 screenshot dir so later
    // suites (3+) can read these ids back without re-deriving them.
    const idsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out', 'agenda-v2', 'seed-ids.json');
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
