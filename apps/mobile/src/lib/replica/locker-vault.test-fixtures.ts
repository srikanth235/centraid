/**
 * ONE LOCKER, SEEDED INTO A REPLICA (#922 E7, #928).
 *
 * Six live items across five types, one archived, one trashed, one starred,
 * one tagged and one carrying a connector alias — so a window read from this
 * has subtitles, a shelf, a star and a tag rather than six bare titles. The
 * BROWSABLE HALF ONLY: no sealed column appears here, because none reaches a
 * replica row (`packages/vault/src/replica/locker-sealed-columns.test.ts`
 * proves that end of it against the real vault).
 *
 * Shared by the two oracles that must run over IDENTICAL rows: the phone's
 * airplane-mode proof (`apps/mobile/src/apps/locker/locker-airplane.test.ts`)
 * and the phone-vs-web comparison in
 * `tests/integration-mobile/locker-rows-parity.integration.test.ts`.
 */
import { DatabaseSync } from "node:sqlite";

import { ReplicaSqliteStore } from "@centraid/client/replica/native";

import { NodeSqliteDriver } from "./node-sqlite-driver";

export const VAULT_ID = "personal";
export const SHAPE_ID = "locker-default";
export const FLAGS_SCHEME = "https://centraid.dev/schemes/flags";
export const TAGS_SCHEME = "https://centraid.dev/schemes/locker-tags";

/** The live titles, in the order the window returns them (updated_at desc). */
export const LIVE_TITLES = [
  "Cafe Wifi",
  "Passport",
  "Travel notes",
  "Travel card",
  "Bank",
  "Webmail",
] as const;

/** The two rows that are live but out of the default window. */
export const ARCHIVED_TITLE = "Broadband";
export const TRASHED_TITLE = "Old forum";

export interface SeedEntity {
  entity: string;
  primaryKey: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

function item(
  index: number,
  values: Record<string, unknown>
): Record<string, unknown> {
  return {
    item_id: `item-${index}`,
    username: null,
    url: null,
    email: null,
    network: null,
    expiry: null,
    compromised: 0,
    password_set_at: "2024-01-01T00:00:00.000Z",
    updated_at: `2026-0${index}-01T09:00:00.000Z`,
    archived_at: null,
    deleted_at: null,
    purge_at: null,
    ...values,
  };
}

export function seedEntities(): SeedEntity[] {
  return [
    {
      entity: "locker.item",
      primaryKey: "item_id",
      columns: [
        "item_id",
        "type",
        "title",
        "username",
        "url",
        "email",
        "network",
        "expiry",
        "compromised",
        "password_set_at",
        "updated_at",
        "archived_at",
        "deleted_at",
        "purge_at",
      ],
      rows: [
        item(1, {
          type: "login",
          title: "Webmail",
          username: "ada@example.test",
          url: "http://mail.example.test",
        }),
        item(2, {
          type: "login",
          title: "Bank",
          username: "ada",
          url: "https://bank.example.test",
          compromised: 1,
        }),
        item(3, {
          type: "card",
          title: "Travel card",
          expiry: "2026-04",
        }),
        item(4, { type: "note", title: "Travel notes" }),
        item(5, { type: "identity", title: "Passport", email: "ada@id.test" }),
        item(6, { type: "wifi", title: "Cafe Wifi", network: "CAFE-5G" }),
        item(7, {
          type: "login",
          title: "Broadband",
          username: "ada@isp.test",
          archived_at: "2026-02-01T00:00:00.000Z",
        }),
        item(8, {
          type: "login",
          title: "Old forum",
          username: "ada",
          deleted_at: "2026-03-01T00:00:00.000Z",
          purge_at: "2026-04-01T00:00:00.000Z",
        }),
      ],
    },
    {
      entity: "locker.item_alias",
      primaryKey: "item_id",
      columns: ["item_id", "alias"],
      rows: [{ item_id: "item-2", alias: "bank" }],
    },
    {
      entity: "core.concept_scheme",
      primaryKey: "scheme_id",
      columns: ["scheme_id", "uri"],
      rows: [
        { scheme_id: "scheme-flags", uri: FLAGS_SCHEME },
        { scheme_id: "scheme-locker-tags", uri: TAGS_SCHEME },
      ],
    },
    {
      entity: "core.concept",
      primaryKey: "concept_id",
      columns: ["concept_id", "scheme_id", "pref_label", "notation"],
      rows: [
        {
          concept_id: "concept-starred",
          scheme_id: "scheme-flags",
          pref_label: "Starred",
          notation: "starred",
        },
        {
          concept_id: "concept-money",
          scheme_id: "scheme-locker-tags",
          pref_label: "money",
          notation: "money",
        },
      ],
    },
    {
      entity: "core.tag",
      primaryKey: "tag_id",
      columns: ["tag_id", "concept_id", "target_type", "target_id"],
      rows: [
        {
          tag_id: "tag-star",
          concept_id: "concept-starred",
          target_type: "locker.item",
          target_id: "item-2",
        },
        {
          tag_id: "tag-money",
          concept_id: "concept-money",
          target_type: "locker.item",
          target_id: "item-2",
        },
      ],
    },
  ];
}

export function seedScope(file: string): void {
  const entities = seedEntities();
  const store = new ReplicaSqliteStore(new NodeSqliteDriver(file), VAULT_ID);
  store.bootstrap({
    protocolVersion: 1,
    vaultId: VAULT_ID,
    schemaEpoch: "1",
    cursor: { epoch: "epoch-1", seq: 1 },
    shapes: [
      {
        shapeId: SHAPE_ID,
        appId: "locker",
        entities: entities.map((entity) => ({
          entity: entity.entity,
          primaryKey: entity.primaryKey,
          columns: [...entity.columns],
        })),
      },
    ],
    rows: [],
  });
  store.close();

  const database = new DatabaseSync(file);
  const insert = database.prepare(
    `INSERT INTO replica_row
       (shape_id, entity, row_id, payload_json, oversized_json)
     VALUES (?, ?, ?, ?, '[]')`
  );
  database.exec("BEGIN IMMEDIATE");
  for (const entity of entities)
    for (const row of entity.rows)
      insert.run(
        SHAPE_ID,
        entity.entity,
        String(row[entity.primaryKey]),
        JSON.stringify(row)
      );
  database.exec("COMMIT");
  database.close();
}
