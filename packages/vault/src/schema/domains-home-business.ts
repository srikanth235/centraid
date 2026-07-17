// Domain DDL — schemas `home`, `business` from duaility-ontology.html §03.

export const HOME_DDL = `
CREATE TABLE home_asset_item (
  item_id             TEXT PRIMARY KEY,
  owner_party_id      TEXT NOT NULL REFERENCES core_party(party_id),
  name                TEXT NOT NULL,
  category_concept_id TEXT REFERENCES core_concept(concept_id),
  place_id            TEXT REFERENCES core_place(place_id),
  acquired_txn_id     TEXT REFERENCES core_transaction(txn_id),
  acquired_on         TEXT,
  serial_no           TEXT,
  purchase_price_minor INTEGER CHECK (purchase_price_minor >= 0),
  purchase_currency    TEXT CHECK (purchase_currency IS NULL OR length(purchase_currency) = 3),
  photo_asset_id      TEXT REFERENCES media_media_asset(asset_id),
  disposed_on         TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_asset_item_owner_party ON home_asset_item(owner_party_id);
CREATE INDEX IF NOT EXISTS idx_asset_item_category_concept ON home_asset_item(category_concept_id);
CREATE INDEX IF NOT EXISTS idx_asset_item_place ON home_asset_item(place_id);
CREATE INDEX IF NOT EXISTS idx_asset_item_acquired_txn ON home_asset_item(acquired_txn_id);
CREATE INDEX IF NOT EXISTS idx_asset_item_photo_asset ON home_asset_item(photo_asset_id);

CREATE TABLE home_warranty (
  warranty_id       TEXT PRIMARY KEY,
  item_id           TEXT NOT NULL REFERENCES home_asset_item(item_id),
  provider_party_id TEXT REFERENCES core_party(party_id),
  starts_on         TEXT NOT NULL,
  ends_on           TEXT NOT NULL CHECK (ends_on >= starts_on),
  terms_content_id  TEXT REFERENCES core_content_item(content_id),
  claim_uri         TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_warranty_item ON home_warranty(item_id);
CREATE INDEX IF NOT EXISTS idx_warranty_provider_party ON home_warranty(provider_party_id);
CREATE INDEX IF NOT EXISTS idx_warranty_terms_content ON home_warranty(terms_content_id);

CREATE TABLE home_maintenance_plan (
  plan_id                 TEXT PRIMARY KEY,
  item_id                 TEXT NOT NULL REFERENCES home_asset_item(item_id),
  name                    TEXT NOT NULL,
  rrule                   TEXT NOT NULL,
  last_done_on            TEXT,
  instructions_content_id TEXT REFERENCES core_content_item(content_id),
  current_task_id         TEXT REFERENCES schedule_task(task_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_maintenance_plan_item ON home_maintenance_plan(item_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_plan_instructions_content ON home_maintenance_plan(instructions_content_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_plan_current_task ON home_maintenance_plan(current_task_id);

CREATE TABLE home_utility_meter (
  meter_id           TEXT PRIMARY KEY,
  place_id           TEXT NOT NULL REFERENCES core_place(place_id),
  kind               TEXT NOT NULL CHECK (kind IN ('electricity','gas','water','internet')),
  unit               TEXT NOT NULL,
  billing_account_id TEXT REFERENCES core_account(account_id),
  provider_party_id  TEXT REFERENCES core_party(party_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_utility_meter_place ON home_utility_meter(place_id);
CREATE INDEX IF NOT EXISTS idx_utility_meter_billing_account ON home_utility_meter(billing_account_id);
CREATE INDEX IF NOT EXISTS idx_utility_meter_provider_party ON home_utility_meter(provider_party_id);

CREATE TABLE home_meter_reading (
  reading_id     TEXT PRIMARY KEY,
  meter_id       TEXT NOT NULL REFERENCES home_utility_meter(meter_id),
  observation_id TEXT NOT NULL UNIQUE REFERENCES core_observation(observation_id),
  source         TEXT NOT NULL CHECK (source IN ('manual','photo_ocr','provider_api'))
) STRICT;
CREATE INDEX IF NOT EXISTS idx_meter_reading_meter ON home_meter_reading(meter_id);
`;

export const BUSINESS_DDL = `
CREATE TABLE business_client (
  client_id          TEXT PRIMARY KEY,
  party_id           TEXT NOT NULL UNIQUE REFERENCES core_party(party_id),
  status             TEXT NOT NULL CHECK (status IN ('lead','active','past')),
  default_rate_minor INTEGER CHECK (default_rate_minor >= 0),
  currency           TEXT NOT NULL CHECK (length(currency) = 3),
  payment_terms_days INTEGER NOT NULL CHECK (payment_terms_days >= 0)
) STRICT;

CREATE TABLE business_project (
  project_id   TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL REFERENCES business_client(client_id),
  name         TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('proposed','active','done','cancelled')),
  starts_on    TEXT,
  ends_on      TEXT,
  budget_minor INTEGER CHECK (budget_minor >= 0),
  UNIQUE (client_id, name)
) STRICT;

CREATE TABLE business_time_entry (
  entry_id        TEXT PRIMARY KEY,
  activity_id     TEXT NOT NULL UNIQUE REFERENCES core_activity(activity_id),
  project_id      TEXT NOT NULL REFERENCES business_project(project_id),
  billable        INTEGER NOT NULL CHECK (billable IN (0,1)),
  rate_minor      INTEGER CHECK (rate_minor >= 0),
  invoice_line_id TEXT REFERENCES business_invoice_line(line_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_time_entry_project ON business_time_entry(project_id);
CREATE INDEX IF NOT EXISTS idx_time_entry_invoice_line ON business_time_entry(invoice_line_id);

CREATE TABLE business_invoice (
  invoice_id     TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL REFERENCES business_client(client_id),
  number         TEXT NOT NULL UNIQUE,
  issued_on      TEXT NOT NULL,
  due_on         TEXT NOT NULL CHECK (due_on >= issued_on),
  currency       TEXT NOT NULL CHECK (length(currency) = 3),
  status         TEXT NOT NULL CHECK (status IN ('draft','sent','paid','overdue','void')),
  total_minor    INTEGER NOT NULL CHECK (total_minor >= 0),
  paid_txn_id    TEXT REFERENCES core_transaction(txn_id),
  pdf_content_id TEXT REFERENCES core_content_item(content_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_invoice_client ON business_invoice(client_id);
CREATE INDEX IF NOT EXISTS idx_invoice_paid_txn ON business_invoice(paid_txn_id);
CREATE INDEX IF NOT EXISTS idx_invoice_pdf_content ON business_invoice(pdf_content_id);

CREATE TABLE business_invoice_line (
  line_id          TEXT PRIMARY KEY,
  invoice_id       TEXT NOT NULL REFERENCES business_invoice(invoice_id),
  description      TEXT NOT NULL,
  qty_scaled       INTEGER NOT NULL CHECK (qty_scaled > 0),
  -- Scaled quantities carry their scale explicitly (issue #441 A3), the pair
  -- finance_holding already uses: qty_scaled is qty × 10^qty_scale. Time-entry
  -- lines bill hours to hundredths, so qty_scale = 2.
  qty_scale        INTEGER NOT NULL CHECK (qty_scale BETWEEN 0 AND 9),
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  amount_minor     INTEGER NOT NULL CHECK (amount_minor >= 0)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_invoice_line_invoice ON business_invoice_line(invoice_id);
`;
