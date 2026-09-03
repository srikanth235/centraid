// governance: allow-repo-hygiene file-size-limit #545 cohesive security/ACID suite for one module
// Direct unit coverage for the S3/S4/S5 invocation bracket (#545).
// Imports `execution.ts` by name and exercises contract validation, precondition
// recording, ACID postcondition rollback, seal sweep, and idempotent replay
// without going through the full Gateway facade for each path.

import { assert, beforeEach, describe, expect, test } from "vitest";

import { bootstrappedVault } from "@centraid/test-kit/vault";

import { bootstrapVault } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { uuidv7 } from "../ids.js";
import { ONTOLOGY_VERSION } from "../schema/migrate.js";
import { isSealedValue } from "../schema/sealed.js";
import type { AccessAllow } from "./access.js";
import type { CommandRow } from "./contract.js";
import {
  assertInvocationIdentity,
  insertInvocation,
  pkColumn,
  replayInvocation,
  runContractAndExecute,
  sealWrites,
  setInvocationStatus,
  polymorphicDenial,
} from "./execution.js";
import type { RegisteredCommand } from "./execution.js";
import type { Identity } from "./types.js";
import { GatewayError } from "./types.js";

let db: VaultDb;
let boot: BootstrapResult;
let identity: Identity;
let consent: AccessAllow;

describe("execution", () => {
  beforeEach(() => {
    ({ db, boot } = bootstrappedVault(
      { openVaultDb, bootstrapVault },
      { ownerName: "Priya" }
    ));
    identity = {
      kind: "owner-device",
      callerId: boot.deviceId,
      provAgentKind: "owner",
      partyId: boot.ownerPartyId,
      mayAct: true,
    };
    consent = {
      decision: "allow",
      grantId: null,
      rowFilter: [],
      fieldMask: null,
    };
  });

  function commandRow(
    over: Partial<CommandRow> & { name: string }
  ): CommandRow {
    return {
      command_id: over.command_id ?? uuidv7(),
      name: over.name,
      owner_schema: over.owner_schema ?? "core",
      input_schema_json:
        over.input_schema_json ??
        JSON.stringify({
          type: "object",
          properties: { note: { type: "string" } },
          required: ["note"],
        }),
      output_schema_json:
        over.output_schema_json ?? JSON.stringify({ type: "object" }),
      preconditions_json: over.preconditions_json ?? "[]",
      postconditions_json: over.postconditions_json ?? "[]",
      idempotency: over.idempotency ?? "retry-safe",
      risk: over.risk ?? "low",
      ontology_version: over.ontology_version ?? ONTOLOGY_VERSION,
    };
  }

  test("pkColumn returns the declared primary key column for a vault table", () => {
    expect(pkColumn(db.vault, "core_party")).toBe("party_id");
    expect(pkColumn(db.vault, "core_tag")).toBe("tag_id");
  });

  // THE ENGINE IS THE CHECK (#916, adversarial BUG-10). `POLY_RULES` covered
  // five of fifteen mechanisms and validated after the fact; every (type, id)
  // pair is a composite foreign key into `core_entity` now, so the refusal
  // happens at the statement — for all fifteen, including the ones the
  // hand-written list never mentioned.
  test("a tag at a row that does not exist is refused by the engine", () => {
    const conceptId = Object.values(boot.concepts)[0] as string;
    expect(() =>
      db.vault
        .prepare(
          `INSERT INTO core_tag (tag_id, target_type, target_id, concept_id, tagged_at)
         VALUES (?, 'core.party', 'no-such-party', ?, ?)`
        )
        .run(uuidv7(), conceptId, new Date().toISOString())
    ).toThrow(/FOREIGN KEY/iu);
  });

  test("an unknown entity name in a type column is refused too", () => {
    const conceptId = Object.values(boot.concepts)[0] as string;
    expect(() =>
      db.vault
        .prepare(
          `INSERT INTO core_tag (tag_id, target_type, target_id, concept_id, tagged_at)
         VALUES (?, 'evil.table', 'x', ?, ?)`
        )
        .run(uuidv7(), conceptId, new Date().toISOString())
    ).toThrow(/FOREIGN KEY/iu);
  });

  test("a mechanism POLY_RULES never covered is refused as well", () => {
    // `enrich_embedding` had `preconditions: []` and no entry in the rules, so
    // a ghost id went in and stayed.
    expect(() =>
      db.vault
        .prepare(
          `INSERT INTO enrich_embedding
             (embedding_id, target_type, target_id, model, dim, vector, created_at)
           VALUES (?, 'core.document', ?, 'fake@1', 1, x'00', ?)`
        )
        .run(uuidv7(), uuidv7(), new Date().toISOString())
    ).toThrow(/FOREIGN KEY/iu);
  });

  test("polymorphicDenial turns the engine's complaint into a readable denial", () => {
    const denial = polymorphicDenial(
      [{ entityType: "core.tag", entityId: "tag-1" }],
      new Error("FOREIGN KEY constraint failed")
    );
    expect(denial).toContain("core.tag tag-1");
    expect(denial).toContain("core_entity");
    // The sentence ends where it says it does — no dangling clause.
    expect(denial).toMatch(/name a live row of a registered entity\.$/u);
    // Not every failure is a polymorphic one.
    expect(
      polymorphicDenial([], new Error("UNIQUE constraint failed"))
    ).toBeNull();
  });

  test("a purged endpoint takes its relation with it (#916 supersedes #272)", () => {
    const partyId = uuidv7();
    const now = new Date().toISOString();
    db.vault
      .prepare(
        `INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
       VALUES (?, 'person', 'Temp', ?, ?)`
      )
      .run(partyId, now, now);
    const relationConcept = Object.values(boot.concepts)[0] as string;
    const linkId = uuidv7();
    db.vault
      .prepare(
        `INSERT INTO core_link
         (link_id, from_type, from_id, to_type, to_id, relation_concept_id, valid_from, asserted_by)
       VALUES (?, 'core.party', ?, 'core.party', ?, ?, ?, 'owner')`
      )
      .run(linkId, partyId, boot.ownerPartyId, relationConcept, now);
    db.vault.prepare("DELETE FROM core_party WHERE party_id = ?").run(partyId);
    // End-dating kept an edge naming a row that is not there, and let an id
    // reused later inherit a relation nobody drew. The cascade deletes it.
    expect(
      db.vault
        .prepare("SELECT count(*) AS n FROM core_link WHERE link_id = ?")
        .get(linkId)
    ).toMatchObject({ n: 0 });
  });

  test("insertInvocation / assertInvocationIdentity / setInvocationStatus journal the bracket", () => {
    const cmd = commandRow({ name: "test.echo" });
    db.vault
      .prepare(
        `INSERT INTO agent_command (command_id, name, owner_schema, input_schema_json, output_schema_json,
         preconditions_json, postconditions_json, idempotency, risk, ontology_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        cmd.command_id,
        cmd.name,
        cmd.owner_schema,
        cmd.input_schema_json,
        cmd.output_schema_json,
        cmd.preconditions_json,
        cmd.postconditions_json,
        cmd.idempotency,
        cmd.risk,
        cmd.ontology_version
      );

    const invocationId = insertInvocation(
      db,
      {
        command: cmd.name,
        input: { note: "hello" },
        purpose: "dpv:ServiceProvision",
      },
      cmd,
      identity,
      null,
      "proposed"
    );
    expect(invocationId.length).toBeGreaterThan(10);
    expect(
      assertInvocationIdentity(
        db,
        invocationId,
        cmd.command_id,
        identity.callerId,
        null
      )
    ).toBe(true);
    expect(
      assertInvocationIdentity(
        db,
        uuidv7(),
        cmd.command_id,
        identity.callerId,
        null
      )
    ).toBe(false);

    expect(() =>
      assertInvocationIdentity(
        db,
        invocationId,
        cmd.command_id,
        "other-caller",
        null
      )
    ).toThrow(GatewayError);

    setInvocationStatus(db, invocationId, "executed");
    const row = db.audit
      .prepare(
        "SELECT status FROM agent_command_invocation WHERE invocation_id = ?"
      )
      .get(invocationId) as { status: string };
    expect(row.status).toBe("executed");
  });

  test("replayInvocation returns null for unknown ids and fails closed for failed rows without receipt", () => {
    expect(replayInvocation(db, uuidv7())).toBeNull();
  });

  test("runContractAndExecute denies a mismatched ontology version before any mutation", () => {
    const cmd = commandRow({ name: "test.versioned", ontology_version: "0.9" });
    db.vault
      .prepare(
        `INSERT INTO agent_command (command_id, name, owner_schema, input_schema_json, output_schema_json,
         preconditions_json, postconditions_json, idempotency, risk, ontology_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        cmd.command_id,
        cmd.name,
        cmd.owner_schema,
        cmd.input_schema_json,
        cmd.output_schema_json,
        cmd.preconditions_json,
        cmd.postconditions_json,
        cmd.idempotency,
        cmd.risk,
        cmd.ontology_version
      );
    const invocationId = insertInvocation(
      db,
      {
        command: cmd.name,
        input: { note: "x" },
        purpose: "dpv:ServiceProvision",
      },
      cmd,
      identity,
      null,
      "proposed"
    );
    const outcome = runContractAndExecute(
      db,
      new Map(),
      identity,
      {
        command: cmd.name,
        input: { note: "x" },
        purpose: "dpv:ServiceProvision",
      },
      cmd,
      consent,
      invocationId
    );
    expect(outcome.status).toBe("failed");
    assert(outcome.status === "failed");
    expect(outcome.reason).toContain("contract version 0.9 not served");
    const checks = db.audit
      .prepare(
        `SELECT count(*) AS n FROM agent_invocation_check WHERE invocation_id = ?`
      )
      .get(invocationId) as { n: number };
    // Version mismatch is a contract deny before preconditions are recorded.
    expect(checks.n).toBe(0);
  });

  test("runContractAndExecute records schema violations and denies without running the handler", () => {
    const cmd = commandRow({ name: "test.schema" });
    db.vault
      .prepare(
        `INSERT INTO agent_command (command_id, name, owner_schema, input_schema_json, output_schema_json,
         preconditions_json, postconditions_json, idempotency, risk, ontology_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        cmd.command_id,
        cmd.name,
        cmd.owner_schema,
        cmd.input_schema_json,
        cmd.output_schema_json,
        cmd.preconditions_json,
        cmd.postconditions_json,
        cmd.idempotency,
        cmd.risk,
        cmd.ontology_version
      );
    let handlerRan = false;
    const registered = new Map<string, RegisteredCommand>([
      [
        cmd.name,
        {
          handler: () => {
            handlerRan = true;
            return {};
          },
          sealedInput: [],
          unseals: [],
          transcriptSensitive: false,
          erasure: false,
        },
      ],
    ]);
    const invocationId = insertInvocation(
      db,
      { command: cmd.name, input: {}, purpose: "dpv:ServiceProvision" },
      cmd,
      identity,
      null,
      "proposed"
    );
    const outcome = runContractAndExecute(
      db,
      registered,
      identity,
      { command: cmd.name, input: {}, purpose: "dpv:ServiceProvision" },
      cmd,
      consent,
      invocationId
    );
    expect(outcome.status).toBe("failed");
    assert(outcome.status === "failed");
    expect(outcome.reason).toBe("input schema violation");
    expect(handlerRan).toBe(false);
  });

  test("runContractAndExecute records a failed precondition and does not open the ACID boundary", () => {
    const cmd = commandRow({
      name: "test.pre",
      preconditions_json: JSON.stringify([
        {
          name: "always-false",
          sql: "SELECT 0 AS value",
          column: "value",
          op: "eq",
          value: 1,
          message: "precondition refused",
        },
      ]),
    });
    db.vault
      .prepare(
        `INSERT INTO agent_command (command_id, name, owner_schema, input_schema_json, output_schema_json,
         preconditions_json, postconditions_json, idempotency, risk, ontology_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        cmd.command_id,
        cmd.name,
        cmd.owner_schema,
        cmd.input_schema_json,
        cmd.output_schema_json,
        cmd.preconditions_json,
        cmd.postconditions_json,
        cmd.idempotency,
        cmd.risk,
        cmd.ontology_version
      );
    let handlerRan = false;
    const registered = new Map<string, RegisteredCommand>([
      [
        cmd.name,
        {
          handler: () => {
            handlerRan = true;
            return {};
          },
          sealedInput: [],
          unseals: [],
          transcriptSensitive: false,
          erasure: false,
        },
      ],
    ]);
    const invocationId = insertInvocation(
      db,
      {
        command: cmd.name,
        input: { note: "x" },
        purpose: "dpv:ServiceProvision",
      },
      cmd,
      identity,
      null,
      "proposed"
    );
    const outcome = runContractAndExecute(
      db,
      registered,
      identity,
      {
        command: cmd.name,
        input: { note: "x" },
        purpose: "dpv:ServiceProvision",
      },
      cmd,
      consent,
      invocationId
    );
    expect(outcome.status).toBe("failed");
    assert(outcome.status === "failed");
    expect(outcome.reason).toBe("precondition refused");
    expect(handlerRan).toBe(false);
    const preCheck = db.audit
      .prepare(
        `SELECT passed FROM agent_invocation_check WHERE invocation_id = ? AND phase = 'pre'`
      )
      .get(invocationId) as { passed: number };
    expect(preCheck.passed).toBe(0);
  });

  test("runContractAndExecute rolls back on postcondition failure and leaves no handler write", () => {
    const cmd = commandRow({
      name: "test.post",
      postconditions_json: JSON.stringify([
        {
          name: "never",
          sql: "SELECT 0 AS value",
          column: "value",
          op: "eq",
          value: 1,
          message: "postcondition refused",
        },
      ]),
    });
    db.vault
      .prepare(
        `INSERT INTO agent_command (command_id, name, owner_schema, input_schema_json, output_schema_json,
         preconditions_json, postconditions_json, idempotency, risk, ontology_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        cmd.command_id,
        cmd.name,
        cmd.owner_schema,
        cmd.input_schema_json,
        cmd.output_schema_json,
        cmd.preconditions_json,
        cmd.postconditions_json,
        cmd.idempotency,
        cmd.risk,
        cmd.ontology_version
      );
    const tagId = uuidv7();
    const conceptId = Object.values(boot.concepts)[0] as string;
    const registered = new Map<string, RegisteredCommand>([
      [
        cmd.name,
        {
          handler: (ctx) => {
            ctx.db
              .prepare(
                `INSERT INTO core_tag (tag_id, target_type, target_id, concept_id, tagged_at)
               VALUES (?, 'core.party', ?, ?, ?)`
              )
              .run(tagId, boot.ownerPartyId, conceptId, ctx.now);
            ctx.wrote("core.tag", tagId);
            return { tag_id: tagId };
          },
          sealedInput: [],
          unseals: [],
          transcriptSensitive: false,
          erasure: false,
        },
      ],
    ]);
    const invocationId = insertInvocation(
      db,
      {
        command: cmd.name,
        input: { note: "x" },
        purpose: "dpv:ServiceProvision",
      },
      cmd,
      identity,
      null,
      "proposed"
    );
    const outcome = runContractAndExecute(
      db,
      registered,
      identity,
      {
        command: cmd.name,
        input: { note: "x" },
        purpose: "dpv:ServiceProvision",
      },
      cmd,
      consent,
      invocationId
    );
    expect(outcome.status).toBe("failed");
    assert(outcome.status === "failed");
    expect(outcome.reason).toBe("postcondition refused");
    const tags = db.vault
      .prepare("SELECT count(*) AS n FROM core_tag WHERE tag_id = ?")
      .get(tagId) as {
      n: number;
    };
    expect(tags.n).toBe(0);
    const status = db.audit
      .prepare(
        "SELECT status FROM agent_command_invocation WHERE invocation_id = ?"
      )
      .get(invocationId) as { status: string };
    expect(status.status).toBe("rolled_back");
  });

  test("runContractAndExecute commits a clean handler write and replays by invocation id", () => {
    const cmd = commandRow({ name: "test.ok" });
    db.vault
      .prepare(
        `INSERT INTO agent_command (command_id, name, owner_schema, input_schema_json, output_schema_json,
         preconditions_json, postconditions_json, idempotency, risk, ontology_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        cmd.command_id,
        cmd.name,
        cmd.owner_schema,
        cmd.input_schema_json,
        cmd.output_schema_json,
        cmd.preconditions_json,
        cmd.postconditions_json,
        cmd.idempotency,
        cmd.risk,
        cmd.ontology_version
      );
    const tagId = uuidv7();
    const conceptId = Object.values(boot.concepts)[0] as string;
    let runs = 0;
    const registered = new Map<string, RegisteredCommand>([
      [
        cmd.name,
        {
          handler: (ctx) => {
            runs += 1;
            ctx.db
              .prepare(
                `INSERT INTO core_tag (tag_id, target_type, target_id, concept_id, tagged_at)
               VALUES (?, 'core.party', ?, ?, ?)`
              )
              .run(tagId, boot.ownerPartyId, conceptId, ctx.now);
            ctx.wrote("core.tag", tagId);
            return { tag_id: tagId };
          },
          sealedInput: [],
          unseals: [],
          transcriptSensitive: false,
          erasure: false,
        },
      ],
    ]);
    const fixedId = uuidv7();
    const invocationId = insertInvocation(
      db,
      {
        command: cmd.name,
        input: { note: "x" },
        purpose: "dpv:ServiceProvision",
        invocationId: fixedId,
      },
      cmd,
      identity,
      null,
      "proposed",
      fixedId
    );
    const outcome = runContractAndExecute(
      db,
      registered,
      identity,
      {
        command: cmd.name,
        input: { note: "x" },
        purpose: "dpv:ServiceProvision",
        invocationId: fixedId,
      },
      cmd,
      consent,
      invocationId
    );
    expect(outcome.status).toBe("executed");
    assert(outcome.status === "executed");
    expect(outcome.output).toStrictEqual({ tag_id: tagId });
    expect(runs).toBe(1);
    const tag = db.vault
      .prepare("SELECT target_id FROM core_tag WHERE tag_id = ?")
      .get(tagId) as {
      target_id: string;
    };
    expect(tag.target_id).toBe(boot.ownerPartyId);

    const replayed = replayInvocation(db, fixedId);
    expect(replayed).toMatchObject({
      status: "replayed",
      invocationId: fixedId,
    });
    assert(replayed?.status === "replayed");
    expect(replayed.output).toStrictEqual({ tag_id: tagId });
    expect(runs).toBe(1);
  });

  test("sealWrites encrypts plaintext sealed columns in place", () => {
    const itemId = uuidv7();
    const now = new Date().toISOString();
    db.vault
      .prepare(
        `INSERT INTO locker_item
         (item_id, type, title, username, password, created_at, updated_at)
       VALUES (?, 'login', 'example.com', 'priya', 'clear-secret', ?, ?)`
      )
      .run(itemId, now, now);
    sealWrites(db, [{ entityType: "locker.item", entityId: itemId }]);
    const row = db.vault
      .prepare("SELECT password, username FROM locker_item WHERE item_id = ?")
      .get(itemId) as { password: string; username: string };
    expect(isSealedValue(row.password)).toBe(true);
    expect(row.username).toBe("priya");
  });
});
