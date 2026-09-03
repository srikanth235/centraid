import { DatabaseSync } from "node:sqlite";

export function userVersionOf(file: string): number {
  const raw = new DatabaseSync(file);
  const row = raw.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  raw.close();
  return row.user_version;
}

export function columnNames(db: DatabaseSync, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((column) => column.name);
}

export const EDITABLE_DOMAIN_TABLES = [
  "core_document",
  "core_event",
  "core_party",
  "knowledge_note",
  "locker_item",
  "locker_item_field",
  "locker_item_passkey",
  "locker_auth_credential",
  "people_profile",
  "people_important_date",
  "schedule_project",
  "schedule_section",
  "schedule_recurrence_exception",
  "social_contact_channel",
  "tally_friend",
  "tally_group",
  "tally_expense",
  "tally_expense_split",
  "tally_expense_line_item",
  "tally_expense_line_allocation",
  "tally_recurring_expense",
  "tally_settlement",
  "tally_obligation",
] as const;
